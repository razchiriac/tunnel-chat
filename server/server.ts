import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

type RoomRecord = {
  offerSDP: string;
  offerSocket: WebSocket;
  createdAt: number;
  ttlMs: number;
  ttlTimer: NodeJS.Timeout;
  // track candidates pre-answer (optional)
  candidatesToCreator: any[];
};

const PORT          = Number(process.env.PORT ?? 8787);
const TTL_MS        = Number(process.env.TTL_MS ?? 2 * 60 * 1000);  // handshake TTL
const JOIN_WAIT_MS  = Number(process.env.JOIN_WAIT_MS ?? 30_000);

const TURN_REALM    = process.env.TURN_REALM ?? 'ditch.chat';
const TURN_SECRET   = process.env.TURN_SECRET || ''; // coturn static-auth-secret
const KEYS_PATH     = process.env.KEYS_PATH ?? path.join(process.cwd(), 'server', 'keys.json');

// In-memory rooms
const rooms = new Map<string, RoomRecord>();
// Joiners who arrived before creator
const pendingWaiters = new Map<string, Set<WebSocket>>();
// After answer, we delete the room. (For full trickle post-answer, you’d track both sockets elsewhere.)

// ---- Keys store (very simple JSON) ----
function ensureKeysFile() {
  try { fs.mkdirSync(path.dirname(KEYS_PATH), { recursive: true }); } catch {}
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
  const username = `${Math.floor(Date.now()/1000) + ttlSeconds}:${customerId}`;
  const hmac = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return { username, credential: hmac, ttlSeconds };
}

const server = http.createServer((req, res) => {
  // Minimal /auth/turn?key=API_KEY
  if (req.method === 'GET' && req.url?.startsWith('/auth/turn')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = url.searchParams.get('key') || '';
    res.setHeader('content-type', 'application/json');
    res.setHeader('access-control-allow-origin', '*');
    try {
      if (!key || !hasKey(key)) { res.statusCode = 401; res.end(JSON.stringify({ error: 'invalid_key' })); return; }
      // Use key as customerId surrogate for MVP
      const creds = makeTurnRestCred(key, 3600);
      res.end(JSON.stringify(creds));
    } catch (e:any) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message || 'server_error' }));
    }
    return;
  }

  res.statusCode = 404;
  res.end('not found');
});

const wss = new WebSocketServer({ server });

function deleteRoom(name: string) {
  const rec = rooms.get(name);
  if (!rec) return;
  try { clearTimeout(rec.ttlTimer); } catch {}
  rooms.delete(name);
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch {
      try { ws.send(JSON.stringify({ type: 'error', error: 'bad_json' })); } catch {}
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
          try { waiter.send(JSON.stringify({ type: 'offer', name, sdp })); } catch {}
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
        try { ws.send(JSON.stringify({ type: 'not_found', name })); } catch {}
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
      try { ws.send(JSON.stringify({ type: 'ok' })); } catch {}
      return;
    }

    // TRICKLE: forward candidate to creator while room exists
    if (type === 'candidate' && msg.name && typeof msg.candidate === 'string') {
      const rec = rooms.get(msg.name);
      if (rec) {
        try { rec.offerSocket.send(JSON.stringify({ type: 'candidate', ...msg })); } catch {}
      }
      return;
    }

    try { ws.send(JSON.stringify({ type: 'error', error: 'unknown_type' })); } catch {}
  });

  ws.on('close', () => {
    // If creator disconnects early, nuke their room
    for (const [name, rec] of rooms) if (rec.offerSocket === ws) deleteRoom(name);
  });
});

server.listen(PORT, () => {
  console.log(`[signaling] ws+http listening on 0.0.0.0:${PORT}`);
  console.log(`[signaling] TTL=${TTL_MS/1000}s JOIN_WAIT=${JOIN_WAIT_MS/1000}s TURN_REALM=${TURN_REALM}`);
});
