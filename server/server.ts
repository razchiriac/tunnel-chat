import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';

type RoomRecord = {
  offerSDP: string;
  offerSocket: WebSocket;
  createdAt: number;
  ttlMs: number;
  ttlTimer: NodeJS.Timeout;
  // track candidates pre-answer (optional)
  candidatesToCreator: any[];
};

const PORT = Number(process.env.PORT ?? 8787);
const TTL_MS = Number(process.env.TTL_MS ?? 2 * 60 * 1000);  // handshake TTL
const JOIN_WAIT_MS = Number(process.env.JOIN_WAIT_MS ?? 30_000);

/** --- Email magic-link auth for CLI `npx tunnel-chat auth <email>` --- */
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://ditch.chat';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'no-reply@ditch.chat';

// Where Stripe wrote user keys (email -> "sk_..." string)
const KEYS_PATH_AUTH = path.resolve(process.cwd(), 'server/keys.json');

type Magic = { email: string; exp: number };
const magicTokens = new Map<string, Magic>();

function readKeys(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(KEYS_PATH_AUTH, 'utf8')); }
  catch { return {}; }
}
function lookupKeyByEmail(email: string): string | null {
  const keys = readKeys();
  return keys[email] || null;
}
function createToken(email: string, ttlSec = 900): string {
  const token = crypto.randomBytes(24).toString('base64url');
  magicTokens.set(token, { email, exp: Date.now() + ttlSec * 1000 });
  return token;
}
function consumeToken(token: string): string | null {
  const rec = magicTokens.get(token);
  if (!rec) return null;
  magicTokens.delete(token); // single use
  if (Date.now() > rec.exp) return null;
  return rec.email;
}
setInterval(() => {
  const t = Date.now();
  for (const [tok, m] of magicTokens) if (t > m.exp) magicTokens.delete(tok);
}, 60_000);

async function sendMagicEmail(to: string, url: string): Promise<void> {
  if (!RESEND_API_KEY) {
    console.log(`[auth] RESEND_API_KEY not set. Magic link for ${to}: ${url}`);
    return;
  }
  const subject = 'Your Tunnel Chat sign-in link';
  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.45">
    <h2>Sign in to Tunnel Chat</h2>
    <p>Click the button below to reveal your Pro API key.</p>
    <p style="margin:24px 0">
      <a href="${url}" style="background:#111;color:#fff;padding:12px 16px;border-radius:6px;text-decoration:none">Reveal my key</a>
    </p>
    <p style="color:#666;font-size:12px">This link is single-use and expires in 15 minutes.</p>
  </div>`;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to, subject, html })
  });
  if (!resp.ok) {
    console.error('[auth] Resend send failed:', resp.status, await resp.text());
  } else {
    console.log(`[auth] Magic link emailed to ${to}`);
  }
}

const TURN_REALM = process.env.TURN_REALM ?? 'ditch.chat';
const TURN_SECRET = process.env.TURN_SECRET || ''; // coturn static-auth-secret
const KEYS_PATH = process.env.KEYS_PATH ?? path.join(process.cwd(), 'server', 'keys.json');

// In-memory rooms
const rooms = new Map<string, RoomRecord>();
// Joiners who arrived before creator
const pendingWaiters = new Map<string, Set<WebSocket>>();
// After answer, we delete the room. (For full trickle post-answer, you’d track both sockets elsewhere.)

// ---- Keys store (very simple JSON) ----
function ensureKeysFile() {
  try { fs.mkdirSync(path.dirname(KEYS_PATH), { recursive: true }); } catch { }
  if (!fs.existsSync(KEYS_PATH)) fs.writeFileSync(KEYS_PATH, JSON.stringify({ keys: [] }, null, 2));
}
ensureKeysFile();
function hasKey(k: string): boolean {
  try {
    const j = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
    return Array.isArray(j.keys) && j.keys.includes(k);
  } catch { return false; }
}

// ---- TURN REST credential (RFC 5766) ----
function makeTurnRestCred(customerId: string, ttlSeconds = 3600) {
  if (!TURN_SECRET) throw new Error('TURN_SECRET not set');
  const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${customerId}`;
  const hmac = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return { username, credential: hmac, ttlSeconds };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    // POST /auth/key/request  { email }
    if (req.method === 'POST' && url.pathname === '/auth/key/request') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        // Always reply 200 to avoid email enumeration
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

        try {
          const { email } = JSON.parse(body || '{}');
          const clean = (email || '').toString().trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
            console.log('[auth] invalid email');
            return;
          }
          const token = createToken(clean, 15 * 60);
          const revealUrl = `${PUBLIC_BASE_URL}/auth/key/consume?token=${encodeURIComponent(token)}`;
          await sendMagicEmail(clean, revealUrl);
        } catch (e) {
          console.error('[auth] request handler error:', e);
        }
      });
      return;
    }

    // GET /auth/key/consume?token=...
    if (req.method === 'GET' && url.pathname === '/auth/key/consume') {
      const token = url.searchParams.get('token') || '';
      const email = consumeToken(token);
      let key = '';
      if (email) key = lookupKeyByEmail(email) || '';

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const hasKey = Boolean(key);
      res.end(`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tunnel Chat – Your API Key</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    colors: {
                        primary: {
                            50: '#f0f9ff',
                            500: '#3b82f6',
                            600: '#2563eb',
                            700: '#1d4ed8',
                            900: '#1e3a8a'
                        }
                    },
                    animation: {
                        'fade-in': 'fadeIn 0.6s ease-out',
                        'slide-up': 'slideUp 0.5s ease-out'
                    },
                    keyframes: {
                        fadeIn: {
                            '0%': { opacity: '0' },
                            '100%': { opacity: '1' }
                        },
                        slideUp: {
                            '0%': { transform: 'translateY(30px)', opacity: '0' },
                            '100%': { transform: 'translateY(0)', opacity: '1' }
                        }
                    }
                }
            }
        }
    </script>
    <style>
        .gradient-text {
            background: linear-gradient(135deg, #3b82f6, #8b5cf6, #f59e0b);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
    </style>
</head>
<body class="bg-gray-900 text-white min-h-screen">
    <div class="min-h-screen flex items-center justify-center p-4">
        <div class="max-w-2xl w-full bg-gray-800/50 rounded-xl p-8 border border-gray-700 animate-fade-in">
            <!-- Header with Logo -->
            <div class="text-center mb-8">
                <div class="flex items-center justify-center space-x-2 mb-4">
                    <div class="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                        <span class="text-white font-bold text-sm">TC</span>
                    </div>
                    <span class="text-xl font-bold gradient-text">Tunnel Chat</span>
                </div>
                <h1 class="text-3xl font-bold mb-2 ${hasKey ? 'text-green-400' : 'text-red-400'}">${hasKey ? 'Your Pro API Key' : 'No Key Found'}</h1>
                ${email ? `<p class="text-gray-300">For: <strong class="text-blue-400">${email}</strong></p>` : '<p class="text-gray-300">This link is invalid or expired.</p>'}
            </div>

            ${hasKey ? `
                <!-- Success State -->
                <div class="space-y-6">
                    <div class="bg-gray-900/50 rounded-lg p-6 border border-gray-600">
                        <h3 class="text-lg font-semibold mb-3 text-gray-200">Set environment variable:</h3>
                        <div class="bg-gray-900 rounded-lg p-4 font-mono text-sm relative group overflow-hidden">
                            <code class="text-green-400 block break-all whitespace-pre-wrap overflow-wrap-anywhere">export TUNNEL_API_KEY="${key}"</code>
                            <button onclick="copyExportCommand('${key}')" 
                                    class="absolute top-2 right-2 bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-xs transition-colors opacity-0 group-hover:opacity-100">
                                Copy
                            </button>
                        </div>
                    </div>

                    <div class="bg-gray-900/50 rounded-lg p-6 border border-gray-600">
                        <h3 class="text-lg font-semibold mb-3 text-gray-200">Your API Key:</h3>
                        <div class="bg-gray-900 rounded-lg p-4 font-mono text-sm relative group overflow-hidden">
                            <code class="text-blue-400 block break-all whitespace-pre-wrap overflow-wrap-anywhere">${key}</code>
                            <button onclick="copyApiKey('${key}')" 
                                    class="absolute top-2 right-2 bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-xs transition-colors opacity-0 group-hover:opacity-100">
                                Copy
                            </button>
                        </div>
                        <p class="text-gray-400 text-sm mt-3">⚠️ Keep this key secure and do not share it.</p>
                    </div>

                    <div class="text-center">
                        <p class="text-gray-300 mb-4">Now you can start using Tunnel Chat Pro features!</p>
                        <div class="bg-gray-900 rounded-lg p-4 font-mono text-sm inline-flex items-center gap-3">
                            <code class="text-purple-400">npx tunnel-chat@latest</code>
                            <button onclick="copyStartCommand()" class="bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-xs transition-colors">
                                Copy
                            </button>
                        </div>
                    </div>
                </div>
            ` : `
                <!-- No Key State -->
                <div class="text-center space-y-6">
                    <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-6">
                        <h3 class="text-lg font-semibold mb-3 text-red-400">No Active Subscription Found</h3>
                        <p class="text-gray-300 mb-4">We couldn't find a paid subscription associated with this email.</p>
                        <p class="text-gray-300 mb-6">If you recently paid, give it a minute and try again. Otherwise, upgrade to Pro:</p>
                        
                        <div class="bg-gray-900 rounded-lg p-4 font-mono text-sm inline-flex items-center gap-3">
                            <code class="text-blue-400">npx tunnel-chat@latest upgrade</code>
                            <button onclick="copyUpgradeCommand()" class="bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-xs transition-colors">
                                Copy
                            </button>
                        </div>
                    </div>
                </div>
            `}

            <div class="text-center mt-8">
                <p class="text-gray-400 text-sm">This page is safe to close.</p>
            </div>
        </div>
    </div>

    <script>
        // Copy functionality with enhanced feedback
        function copyToClipboard(text, button) {
            navigator.clipboard.writeText(text).then(() => {
                const originalText = button.textContent;
                button.textContent = 'Copied!';
                button.classList.add('bg-green-600', 'text-white');
                button.classList.remove('bg-gray-700', 'hover:bg-gray-600');
                
                setTimeout(() => {
                    button.textContent = originalText;
                    button.classList.remove('bg-green-600', 'text-white');
                    button.classList.add('bg-gray-700', 'hover:bg-gray-600');
                }, 2000);
            }).catch(() => {
                // Fallback for older browsers
                const textArea = document.createElement('textarea');
                textArea.value = text;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
                
                const originalText = button.textContent;
                button.textContent = 'Copied!';
                setTimeout(() => {
                    button.textContent = originalText;
                }, 2000);
            });
        }

        function copyExportCommand(key) {
            const button = event.target;
            copyToClipboard(\`export TUNNEL_API_KEY="\${key}"\`, button);
        }

        function copyApiKey(key) {
            const button = event.target;
            copyToClipboard(key, button);
        }

        function copyStartCommand() {
            const button = event.target;
            copyToClipboard('npx tunnel-chat@latest', button);
        }

        function copyUpgradeCommand() {
            const button = event.target;
            copyToClipboard('npx tunnel-chat@latest upgrade', button);
        }
    </script>
</body>
</html>`);
      return;
    }

    // Minimal /auth/turn?key=API_KEY
    if (req.method === 'GET' && url.pathname === '/auth/turn') {
      const key = url.searchParams.get('key') || '';
      res.setHeader('content-type', 'application/json');
      res.setHeader('access-control-allow-origin', '*');
      try {
        if (!key || !hasKey(key)) { res.statusCode = 401; res.end(JSON.stringify({ error: 'invalid_key' })); return; }
        // Use key as customerId surrogate for MVP
        const creds = makeTurnRestCred(key, 3600);
        res.end(JSON.stringify(creds));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message || 'server_error' }));
      }
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  } catch (e) {
    res.statusCode = 500;
    res.end('error');
    console.error('[http] error:', e);
  }
});

const wss = new WebSocketServer({ server });

function deleteRoom(name: string) {
  const rec = rooms.get(name);
  if (!rec) return;
  try { clearTimeout(rec.ttlTimer); } catch { }
  rooms.delete(name);
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch {
      try { ws.send(JSON.stringify({ type: 'error', error: 'bad_json' })); } catch { }
      return;
    }

    const { type } = msg || {};

    // CREATE
    if (type === 'create') {
      const { name, sdp } = msg;
      if (!name || !sdp) { ws.send(JSON.stringify({ type: 'error', error: 'missing_fields' })); return; }
      if (rooms.has(name)) { ws.send(JSON.stringify({ type: 'error', error: 'room_exists' })); return; }

      const ttlTimer = setTimeout(() => deleteRoom(name), TTL_MS);
      rooms.set(name, {
        offerSDP: sdp,
        offerSocket: ws,
        createdAt: Date.now(),
        ttlMs: TTL_MS,
        ttlTimer,
        candidatesToCreator: [],
      });

      ws.send(JSON.stringify({ type: 'created', name }));

      // Flush pending waiters with offer
      const set = pendingWaiters.get(name);
      if (set && set.size) {
        for (const waiter of set) {
          try { waiter.send(JSON.stringify({ type: 'offer', name, sdp })); } catch { }
        }
        pendingWaiters.delete(name);
      }
      return;
    }

    // JOIN
    if (type === 'join') {
      const { name } = msg;
      if (!name) { ws.send(JSON.stringify({ type: 'error', error: 'missing_fields' })); return; }
      const rec = rooms.get(name);
      if (rec) {
        ws.send(JSON.stringify({ type: 'offer', name, sdp: rec.offerSDP, info: { createdAt: rec.createdAt } }));
        (ws as any).__roomName = name; // useful if you want post-answer forwarding
        return;
      }
      // Wait for the creator up to JOIN_WAIT_MS
      const to = setTimeout(() => {
        try { ws.send(JSON.stringify({ type: 'not_found', name })); } catch { }
        const set = pendingWaiters.get(name); if (set) { set.delete(ws); if (set.size === 0) pendingWaiters.delete(name); }
      }, JOIN_WAIT_MS);
      ws.on('close', () => { clearTimeout(to); const set = pendingWaiters.get(name); if (set) { set.delete(ws); if (set.size === 0) pendingWaiters.delete(name); } });
      if (!pendingWaiters.has(name)) pendingWaiters.set(name, new Set());
      pendingWaiters.get(name)!.add(ws);
      return;
    }

    // ANSWER: forward to creator, then delete room
    if (type === 'answer') {
      const { name, sdp } = msg;
      const rec = rooms.get(name);
      if (!rec) { ws.send(JSON.stringify({ type: 'not_found', name })); return; }
      try { rec.offerSocket.send(JSON.stringify({ type: 'answer', name, sdp })); }
      finally { deleteRoom(name); }
      try { ws.send(JSON.stringify({ type: 'ok' })); } catch { }
      return;
    }

    // TRICKLE: forward candidate to creator while room exists
    if (type === 'candidate' && msg.name && typeof msg.candidate === 'string') {
      const rec = rooms.get(msg.name);
      if (rec) {
        try { rec.offerSocket.send(JSON.stringify({ type: 'candidate', ...msg })); } catch { }
      }
      return;
    }

    try { ws.send(JSON.stringify({ type: 'error', error: 'unknown_type' })); } catch { }
  });

  ws.on('close', () => {
    // If creator disconnects early, nuke their room
    for (const [name, rec] of rooms) if (rec.offerSocket === ws) deleteRoom(name);
  });
});

server.listen(PORT, () => {
  console.log(`[signaling] ws+http listening on 0.0.0.0:${PORT}`);
  console.log(`[signaling] TTL=${TTL_MS / 1000}s JOIN_WAIT=${JOIN_WAIT_MS / 1000}s TURN_REALM=${TURN_REALM}`);
});
