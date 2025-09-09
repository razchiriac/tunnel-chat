import crypto, { createHmac } from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import Stripe from 'stripe';
import { WebSocket, WebSocketServer } from 'ws';

// Server configuration
const PORT = Number(process.env.PORT ?? 8787);
const TTL_MS = Number(process.env.TTL_MS ?? 2 * 60 * 1000);
const JOIN_WAIT_MS = Number(process.env.JOIN_WAIT_MS ?? 30_000);

// TURN configuration
const TURN_REALM = process.env.TURN_REALM ?? 'ditch.chat';
const TURN_SECRET = process.env.TURN_SECRET || '';

// Billing configuration
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const KEYS_PATH = process.env.KEYS_PATH ?? path.join(process.cwd(), 'server', 'keys.json');

// Email magic-link auth configuration for CLI `npx tunnel-chat auth <email>`
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://ditch.chat';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'no-reply@ditch.chat';

// Initialize Stripe
const stripe = new Stripe(STRIPE_SECRET, {});

// Magic token management for email auth
type Magic = { email: string; exp: number };
const magicTokens = new Map<string, Magic>();

// Helper functions for magic token auth
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

// Clean up expired tokens every minute
setInterval(() => {
    const t = Date.now();
    for (const [tok, m] of magicTokens) if (t > m.exp) magicTokens.delete(tok);
}, 60_000);

// Send magic link email using Resend API
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

// Signaling server types and state
type RoomRecord = {
    // single-peer legacy fields
    offerSDP?: string;
    // owner/creator socket (for both modes)
    offerSocket: WebSocket;
    createdAt: number;
    ttlMs: number;
    ttlTimer: NodeJS.Timeout;
    candidatesToCreator: any[];
    // multi-peer fields
    multi?: boolean;
    joiners?: Map<string, WebSocket>; // peerId -> joiner socket
};

const rooms = new Map<string, RoomRecord>();
const pendingWaiters = new Map<string, Set<WebSocket>>();

// ---------- Keys store helpers ----------
function ensureKeysFile() {
    try { fs.mkdirSync(path.dirname(KEYS_PATH), { recursive: true }); } catch { }
    if (!fs.existsSync(KEYS_PATH)) fs.writeFileSync(KEYS_PATH, JSON.stringify({ keys: [] }, null, 2));
}
function loadKeys(): string[] {
    try { const j = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8')); return j.keys || []; } catch { return []; }
}
function saveKeys(arr: string[]) { fs.writeFileSync(KEYS_PATH, JSON.stringify({ keys: arr }, null, 2)); }
function addKey(k: string) { const s = new Set(loadKeys()); s.add(k); saveKeys([...s]); }
function removeKey(k: string) { const s = new Set(loadKeys()); s.delete(k); saveKeys([...s]); }

// ---------- Billing helpers ----------
function json(res: http.ServerResponse, code: number, obj: any) {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json');
    res.setHeader('access-control-allow-origin', '*');
    res.end(JSON.stringify(obj));
}

async function provisionKeyForCustomer(customerId: string | null | undefined) {
    const apiKey = 'sk_ditch_' + crypto.randomBytes(24).toString('hex');
    addKey(apiKey);
    if (customerId) {
        try {
            await stripe.customers.update(customerId, { metadata: { ditch_api_key: apiKey } });
        } catch (e) {
            console.error('[billing] failed to attach key to customer metadata:', (e as Error).message);
        }
    }
    console.log('[billing] PROVISIONED KEY', apiKey, 'for customer', customerId ?? '(unknown)');
    return apiKey;
}

async function revokeKeyForCustomer(customerId: string | null | undefined) {
    if (!customerId) return;
    try {
        const cust = await stripe.customers.retrieve(customerId) as Stripe.Customer;
        const k = cust.metadata?.ditch_api_key;
        if (k) {
            removeKey(k);
            console.log('[billing] REVOKED KEY', k, 'for customer', customerId);
        } else {
            console.log('[billing] no key in metadata to revoke for', customerId);
        }
    } catch (e) {
        console.error('[billing] revoke error:', (e as Error).message);
    }
}

// ---------- TURN helpers ----------
function hasKey(k: string): boolean {
    try {
        const j = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
        return Array.isArray(j.keys) && j.keys.includes(k);
    } catch { return false; }
}

function makeTurnRestCred(customerId: string, ttlSeconds = 3600) {
    if (!TURN_SECRET) throw new Error('TURN_SECRET not set');
    const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${customerId}`;
    const hmac = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    return { username, credential: hmac, ttlSeconds };
}

// ---------- Signaling helpers ----------
function deleteRoom(name: string) {
    const rec = rooms.get(name);
    if (!rec) return;
    try { clearTimeout(rec.ttlTimer); } catch { }
    rooms.delete(name);
}

// Initialize keys file
ensureKeysFile();

// Create HTTP server that handles both billing and signaling
const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-headers', '*');
        res.statusCode = 204;
        return res.end();
    }

    // Billing endpoints
    if (req.method === 'POST' && req.url === '/create-checkout-session') {
        if (!PRICE_ID) return json(res, 500, { error: 'missing STRIPE_PRICE_ID' });
        try {
            const session = await stripe.checkout.sessions.create({
                mode: 'subscription',
                line_items: [{ price: PRICE_ID, quantity: 1 }],
                success_url: 'https://ditch.chat/success',
                cancel_url: 'https://ditch.chat/cancel',
            });
            return json(res, 200, { url: session.url });
        } catch (e: any) {
            console.error('[billing] create-checkout-session error:', e.message);
            return json(res, 500, { error: e.message || 'stripe_error' });
        }
    }

    if (req.method === 'POST' && req.url === '/webhook') {
        let raw = Buffer.alloc(0);
        req.on('data', c => raw = Buffer.concat([raw, c]));
        req.on('end', async () => {
            let evt: Stripe.Event;
            try {
                if (!WEBHOOK_SECRET) throw new Error('WEBHOOK_SECRET not set');
                const sig = req.headers['stripe-signature'] as string;
                evt = stripe.webhooks.constructEvent(raw, sig, WEBHOOK_SECRET);
            } catch (e: any) {
                console.error('[billing] webhook signature error:', e.message);
                res.statusCode = 400; return res.end(`Webhook Error: ${e.message}`);
            }

            console.log('[billing] webhook:', evt.type);

            try {
                let customerId: string | undefined;

                switch (evt.type) {
                    case 'checkout.session.completed':
                    case 'checkout.session.async_payment_succeeded': {
                        const cs = evt.data.object as Stripe.Checkout.Session;
                        customerId = (cs.customer as string) || undefined;
                        if (customerId) {
                            const c = await stripe.customers.retrieve(customerId) as Stripe.Customer;
                            if (!c.metadata?.ditch_api_key) await provisionKeyForCustomer(customerId);
                        } else {
                            await provisionKeyForCustomer(undefined);
                        }
                        break;
                    }

                    case 'customer.subscription.created':
                    case 'customer.subscription.updated': {
                        const sub = evt.data.object as Stripe.Subscription;
                        customerId = (sub.customer as string) || undefined;
                        const status = sub.status;
                        if (status === 'active' || status === 'trialing') {
                            if (customerId) {
                                const c = await stripe.customers.retrieve(customerId) as Stripe.Customer;
                                if (!c.metadata?.ditch_api_key) await provisionKeyForCustomer(customerId);
                            } else {
                                await provisionKeyForCustomer(undefined);
                            }
                        }
                        break;
                    }

                    case 'invoice.paid': {
                        const inv = evt.data.object as Stripe.Invoice;
                        customerId = (inv.customer as string) || undefined;
                        if (customerId) {
                            const c = await stripe.customers.retrieve(customerId) as Stripe.Customer;
                            if (!c.metadata?.ditch_api_key) await provisionKeyForCustomer(customerId);
                        }
                        break;
                    }

                    case 'customer.subscription.deleted': {
                        const sub = evt.data.object as Stripe.Subscription;
                        await revokeKeyForCustomer(sub.customer as string);
                        break;
                    }

                    default:
                        break;
                }

                res.end('ok');
            } catch (e: any) {
                console.error('[billing] webhook handler error:', e.message);
                res.statusCode = 500; res.end(e.message || 'handler_error');
            }
        });
        return;
    }

    // POST /auth/key/request - Send magic link email for CLI authentication
    if (req.method === 'POST' && req.url === '/auth/key/request') {
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
                const token = createToken(clean, 15 * 60); // 15 minutes
                const revealUrl = `${PUBLIC_BASE_URL}/auth/key/consume?token=${encodeURIComponent(token)}`;
                await sendMagicEmail(clean, revealUrl);
            } catch (e) {
                console.error('[auth] request handler error:', e);
            }
        });
        return;
    }

    // GET /auth/key/consume?token=... - Handle magic link consumption (must come before /auth/key)
    if (req.method === 'GET' && req.url?.startsWith('/auth/key/consume')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const token = url.searchParams.get('token');

        if (!token) {
            res.writeHead(400, { 'content-type': 'text/html' });
            res.end(`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tunnel Chat – Invalid Link</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    animation: {
                        'fade-in': 'fadeIn 0.6s ease-out'
                    },
                    keyframes: {
                        fadeIn: {
                            '0%': { opacity: '0' },
                            '100%': { opacity: '1' }
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
            <div class="text-center">
                <div class="flex items-center justify-center space-x-2 mb-6">
                    <div class="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                        <span class="text-white font-bold text-sm">TC</span>
                    </div>
                    <span class="text-xl font-bold gradient-text">Tunnel Chat</span>
                </div>
                <h1 class="text-3xl font-bold mb-4 text-red-400">Invalid Link</h1>
                <p class="text-gray-300 mb-6">Missing token parameter.</p>
                <p class="text-gray-400 text-sm">Please check your email for the correct link.</p>
            </div>
        </div>
    </div>
</body>
</html>`);
            return;
        }

        const email = consumeToken(token);
        if (!email) {
            res.writeHead(400, { 'content-type': 'text/html' });
            res.end(`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tunnel Chat – Invalid Link</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    animation: {
                        'fade-in': 'fadeIn 0.6s ease-out'
                    },
                    keyframes: {
                        fadeIn: {
                            '0%': { opacity: '0' },
                            '100%': { opacity: '1' }
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
            <div class="text-center">
                <div class="flex items-center justify-center space-x-2 mb-6">
                    <div class="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                        <span class="text-white font-bold text-sm">TC</span>
                    </div>
                    <span class="text-xl font-bold gradient-text">Tunnel Chat</span>
                </div>
                <h1 class="text-3xl font-bold mb-4 text-red-400">Invalid or Expired Link</h1>
                <p class="text-gray-300 mb-6">This link is invalid or has already been used.</p>
                <p class="text-gray-400 text-sm">Please request a new magic link from your terminal.</p>
            </div>
        </div>
    </div>
</body>
</html>`);
            return;
        }

        try {
            // Search for customers by email in Stripe
            console.log(`[auth] Looking for customers with email: ${email}`);
            const customers = await stripe.customers.list({ email, limit: 100 });
            console.log(`[auth] Found ${customers.data.length} customers`);

            if (customers.data.length === 0) {
                console.log(`[auth] No customers found for email: ${email}`);
                res.writeHead(404, { 'content-type': 'text/html' });
                res.end(`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tunnel Chat – Account Not Found</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    animation: {
                        'fade-in': 'fadeIn 0.6s ease-out'
                    },
                    keyframes: {
                        fadeIn: {
                            '0%': { opacity: '0' },
                            '100%': { opacity: '1' }
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
            <div class="text-center space-y-6">
                <div class="flex items-center justify-center space-x-2 mb-6">
                    <div class="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                        <span class="text-white font-bold text-sm">TC</span>
                    </div>
                    <span class="text-xl font-bold gradient-text">Tunnel Chat</span>
                </div>
                <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-6">
                    <h1 class="text-3xl font-bold mb-4 text-red-400">Account Not Found</h1>
                    <p class="text-gray-300 mb-6">No account found for this email address.</p>
                    <p class="text-gray-300 mb-6">To get started with Tunnel Chat Pro, run:</p>
                    
                    <div class="bg-gray-900 rounded-lg p-4 font-mono text-sm inline-flex items-center gap-3">
                        <code class="text-blue-400">npx tunnel-chat@latest upgrade</code>
                        <button onclick="copyUpgradeCommand()" class="bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-xs transition-colors">
                            Copy
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        function copyUpgradeCommand() {
            const button = event.target;
            navigator.clipboard.writeText('npx tunnel-chat@latest upgrade').then(() => {
                const originalText = button.textContent;
                button.textContent = 'Copied!';
                button.classList.add('bg-green-600', 'text-white');
                button.classList.remove('bg-gray-700', 'hover:bg-gray-600');
                
                setTimeout(() => {
                    button.textContent = originalText;
                    button.classList.remove('bg-green-600', 'text-white');
                    button.classList.add('bg-gray-700', 'hover:bg-gray-600');
                }, 2000);
            });
        }
    </script>
</body>
</html>`);
                return;
            }

            const keys = loadKeys();

            // Find existing key
            for (const c of customers.data) {
                const k = c.metadata?.ditch_api_key;
                if (k && keys.includes(k)) {
                    res.writeHead(200, { 'content-type': 'text/html' });
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
                        'fade-in': 'fadeIn 0.6s ease-out'
                    },
                    keyframes: {
                        fadeIn: {
                            '0%': { opacity: '0' },
                            '100%': { opacity: '1' }
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
                <h1 class="text-3xl font-bold mb-2 text-green-400">Your Pro API Key</h1>
            </div>

            <!-- Success State -->
            <div class="space-y-6">
                <div class="bg-gray-900/50 rounded-lg p-6 border border-gray-600">
                    <h3 class="text-lg font-semibold mb-3 text-gray-200">Set environment variable:</h3>
                    <div class="bg-gray-900 rounded-lg p-4 font-mono text-sm relative group">
                        <code class="text-green-400">export TUNNEL_API_KEY="${k}"</code>
                        <button onclick="copyExportCommand('${k}')" 
                                class="absolute top-2 right-2 bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-xs transition-colors opacity-0 group-hover:opacity-100">
                            Copy
                        </button>
                    </div>
                </div>

                <div class="bg-gray-900/50 rounded-lg p-6 border border-gray-600">
                    <h3 class="text-lg font-semibold mb-3 text-gray-200">Your API Key:</h3>
                    <div class="bg-gray-900 rounded-lg p-4 font-mono text-sm relative group break-all">
                        <code class="text-blue-400">${k}</code>
                        <button onclick="copyApiKey('${k}')" 
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
    </script>
</body>
</html>`);
                    return;
                }
            }

            // Try to retro-provision for active subscriber
            for (const c of customers.data) {
                try {
                    console.log(`[auth] Checking subscriptions for customer ${c.id} (email: ${c.email})`);
                    // Check for both active and trialing subscriptions
                    const activeSubs = await stripe.subscriptions.list({ customer: c.id, status: 'active', limit: 1 });
                    const trialingSubs = await stripe.subscriptions.list({ customer: c.id, status: 'trialing', limit: 1 });
                    const subs = { data: [...activeSubs.data, ...trialingSubs.data] };
                    console.log(`[auth] Found ${subs.data.length} active/trialing subscriptions for customer ${c.id}`);

                    if (subs.data.length > 0) {
                        const sub = subs.data[0];
                        console.log(`[auth] Active subscription found: ${sub.id}, status: ${sub.status}`);
                        const newKey = await provisionKeyForCustomer(c.id);
                        console.log(`[auth] Provisioned new key for customer ${c.id}: ${newKey}`);
                        res.writeHead(200, { 'content-type': 'text/html' });
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
                        'fade-in': 'fadeIn 0.6s ease-out'
                    },
                    keyframes: {
                        fadeIn: {
                            '0%': { opacity: '0' },
                            '100%': { opacity: '1' }
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
                <h1 class="text-3xl font-bold mb-2 text-green-400">Your Pro API Key</h1>
            </div>

            <!-- Success State -->
            <div class="space-y-6">
                <div class="bg-gray-900/50 rounded-lg p-6 border border-gray-600">
                    <h3 class="text-lg font-semibold mb-3 text-gray-200">Set environment variable:</h3>
                    <div class="bg-gray-900 rounded-lg p-4 font-mono text-sm relative group">
                        <code class="text-green-400">export TUNNEL_API_KEY="${newKey}"</code>
                        <button onclick="copyExportCommand('${newKey}')" 
                                class="absolute top-2 right-2 bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-xs transition-colors opacity-0 group-hover:opacity-100">
                            Copy
                        </button>
                    </div>
                </div>

                <div class="bg-gray-900/50 rounded-lg p-6 border border-gray-600">
                    <h3 class="text-lg font-semibold mb-3 text-gray-200">Your API Key:</h3>
                    <div class="bg-gray-900 rounded-lg p-4 font-mono text-sm relative group break-all">
                        <code class="text-blue-400">${newKey}</code>
                        <button onclick="copyApiKey('${newKey}')" 
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
    </script>
</body>
</html>`);
                        return;
                    } else {
                        console.log(`[auth] No active subscriptions found for customer ${c.id}`);
                        // Let's also check for other subscription statuses
                        const allSubs = await stripe.subscriptions.list({ customer: c.id, limit: 10 });
                        console.log(`[auth] All subscriptions for customer ${c.id}:`, allSubs.data.map(s => ({ id: s.id, status: s.status })));
                    }
                } catch (e: any) {
                    console.error('[auth] subscription check failed during consume:', e.message);
                }
            }

            res.writeHead(404, { 'content-type': 'text/html' });
            res.end(`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tunnel Chat – No Active Subscription</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    animation: {
                        'fade-in': 'fadeIn 0.6s ease-out'
                    },
                    keyframes: {
                        fadeIn: {
                            '0%': { opacity: '0' },
                            '100%': { opacity: '1' }
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
            <div class="text-center space-y-6">
                <div class="flex items-center justify-center space-x-2 mb-6">
                    <div class="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                        <span class="text-white font-bold text-sm">TC</span>
                    </div>
                    <span class="text-xl font-bold gradient-text">Tunnel Chat</span>
                </div>
                <div class="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-6">
                    <h1 class="text-3xl font-bold mb-4 text-yellow-400">No Active Subscription</h1>
                    <p class="text-gray-300 mb-4">No active subscription found for this email address.</p>
                    <p class="text-gray-300 mb-6">If you recently paid, give it a minute and try again. Otherwise, upgrade to Pro:</p>
                    
                    <div class="bg-gray-900 rounded-lg p-4 font-mono text-sm inline-flex items-center gap-3">
                        <code class="text-blue-400">npx tunnel-chat@latest upgrade</code>
                        <button onclick="copyUpgradeCommand()" class="bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-xs transition-colors">
                            Copy
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        function copyUpgradeCommand() {
            const button = event.target;
            navigator.clipboard.writeText('npx tunnel-chat@latest upgrade').then(() => {
                const originalText = button.textContent;
                button.textContent = 'Copied!';
                button.classList.add('bg-green-600', 'text-white');
                button.classList.remove('bg-gray-700', 'hover:bg-gray-600');
                
                setTimeout(() => {
                    button.textContent = originalText;
                    button.classList.remove('bg-green-600', 'text-white');
                    button.classList.add('bg-gray-700', 'hover:bg-gray-600');
                }, 2000);
            });
        }
    </script>
</body>
</html>`);

        } catch (e: any) {
            console.error('[auth] consume error:', e.message);
            res.writeHead(500, { 'content-type': 'text/html' });
            res.end(`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tunnel Chat – Server Error</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    animation: {
                        'fade-in': 'fadeIn 0.6s ease-out'
                    },
                    keyframes: {
                        fadeIn: {
                            '0%': { opacity: '0' },
                            '100%': { opacity: '1' }
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
            <div class="text-center">
                <div class="flex items-center justify-center space-x-2 mb-6">
                    <div class="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                        <span class="text-white font-bold text-sm">TC</span>
                    </div>
                    <span class="text-xl font-bold gradient-text">Tunnel Chat</span>
                </div>
                <h1 class="text-3xl font-bold mb-4 text-red-400">Server Error</h1>
                <p class="text-gray-300 mb-6">An error occurred while processing your request.</p>
                <p class="text-gray-400 text-sm">Please try again later or contact support if the issue persists.</p>
            </div>
        </div>
    </div>
</body>
</html>`);
        }
        return;
    }

    // Auth endpoint: retrieve key by email
    if (req.method === 'GET' && req.url?.startsWith('/auth/key')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const email = url.searchParams.get('email');

        if (!email) {
            return json(res, 400, { error: 'email parameter required' });
        }

        try {
            // Search for ALL customers by email in Stripe (can be multiple)
            const customers = await stripe.customers.list({ email, limit: 100 });

            if (customers.data.length === 0) {
                return json(res, 404, { error: 'no_customer_found' });
            }

            const keys = loadKeys();

            // Pass 1: return first valid existing key across customers
            for (const c of customers.data) {
                const k = c.metadata?.ditch_api_key;
                if (k && keys.includes(k)) {
                    console.log('[billing] API key retrieved for email (multi-customer match):', email);
                    return json(res, 200, { key: k });
                }
            }

            // Pass 2: retro-provision for first customer with active or trialing subscription
            for (const c of customers.data) {
                try {
                    // Check for both active and trialing subscriptions
                    const activeSubs = await stripe.subscriptions.list({ customer: c.id, status: 'active', limit: 1 });
                    const trialingSubs = await stripe.subscriptions.list({ customer: c.id, status: 'trialing', limit: 1 });
                    const subs = { data: [...activeSubs.data, ...trialingSubs.data] };
                    if (subs.data.length > 0) {
                        const k = c.metadata?.ditch_api_key;
                        if (!k || !keys.includes(k)) {
                            console.log('[billing] retro-provisioning API key for active subscriber (multi-customer)');
                            const newKey = await provisionKeyForCustomer(c.id);
                            return json(res, 200, { key: newKey });
                        }
                    }
                } catch (e: any) {
                    console.error('[billing] subscription check failed during retro-provision (multi-customer):', e.message);
                }
            }

            // Optional: clean stale metadata keys that are no longer in store (best-effort)
            for (const c of customers.data) {
                const k = c.metadata?.ditch_api_key;
                if (k && !keys.includes(k)) {
                    try { await stripe.customers.update(c.id, { metadata: { ...c.metadata, ditch_api_key: '' } }); } catch { }
                }
            }

            return json(res, 404, { error: 'no_api_key_found' });

        } catch (e: any) {
            console.error('[billing] auth/key error:', e.message);
            return json(res, 500, { error: e.message || 'server_error' });
        }
    }

    // TURN auth endpoint
    if (req.method === 'GET' && req.url?.startsWith('/auth/turn')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const key = url.searchParams.get('key') || '';
        res.setHeader('content-type', 'application/json');
        res.setHeader('access-control-allow-origin', '*');
        try {
            if (!key || !hasKey(key)) {
                res.statusCode = 401;
                res.end(JSON.stringify({ error: 'invalid_key' }));
                return;
            }
            const creds = makeTurnRestCred(key, 3600);
            res.end(JSON.stringify(creds));
        } catch (e: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message || 'server_error' }));
        }
        return;
    }

    // ==========================
    // Pro uploads: presigned URLs
    // POST /auth/upload  body: { filename, size, mime }
    // Auth: Authorization: Bearer <key>
    if (req.method === 'POST' && req.url === '/auth/upload') {
        try {
            const auth = (req.headers['authorization'] || '').toString();
            const key = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
            if (!key || !hasKey(key)) { return json(res, 401, { error: 'invalid_key' }); }

            let raw = '';
            await new Promise<void>((resolve) => { req.on('data', c => raw += c); req.on('end', () => resolve()); });
            let body: any = {};
            try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'bad_json' }); }
            const filename = (body.filename || '').toString();
            const size = Number(body.size || 0);
            const mime = (body.mime || 'application/octet-stream').toString();
            if (!filename || !Number.isFinite(size) || size <= 0) return json(res, 400, { error: 'missing_fields' });

            const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024);
            if (size > MAX_BYTES) return json(res, 413, { error: 'too_large', max: MAX_BYTES });

            const provider = (process.env.STORAGE_PROVIDER || 's3').toLowerCase();
            if (provider !== 's3' && provider !== 'r2') return json(res, 500, { error: 'unsupported_provider' });

            const bucket = process.env.S3_BUCKET || '';
            // Cloudflare R2 requires SigV4 region to be exactly "auto" regardless of any S3_REGION value
            const region = provider === 'r2' ? 'auto' : (process.env.S3_REGION || 'auto');
            const accessKey = process.env.S3_ACCESS_KEY_ID || '';
            const secretKey = process.env.S3_SECRET_ACCESS_KEY || '';
            const endpoint = process.env.S3_ENDPOINT || '';
            const publicBase = process.env.S3_PUBLIC_BASE || '';
            const ttlSec = Number(process.env.PRESIGN_TTL_SECONDS || 600);

            if (!bucket || !accessKey || !secretKey) return json(res, 500, { error: 'storage_not_configured' });

            function sanitizeName(n: string) {
                return n.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180);
            }
            const keyName = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sanitizeName(filename)}`;

            const host = endpoint
                ? new URL(endpoint).host
                : provider === 'r2'
                    ? `${process.env.R2_ACCOUNT_ID ?? ''}.r2.cloudflarestorage.com`
                    : `s3.${region}.amazonaws.com`;
            const protocol = endpoint ? new URL(endpoint).protocol : 'https:';
            const pathPrefix = endpoint ? `/${bucket}` : `/${bucket}`;

            // AWS SigV4 utils
            const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '') + 'Z';
            const shortDate = amzDate.slice(0, 8);
            const service = 's3';
            const credentialScope = `${shortDate}/${region}/${service}/aws4_request`;
            const alg = 'AWS4-HMAC-SHA256';

            function hmac(keyBuf: Buffer | string, data: string) { return createHmac('sha256', keyBuf).update(data).digest(); }
            function sha256Hex(s: string) { return crypto.createHash('sha256').update(s).digest('hex'); }
            function signKey(secret: string) {
                const kDate = hmac('AWS4' + secret, shortDate);
                const kRegion = hmac(kDate, region);
                const kService = hmac(kRegion, service);
                const kSigning = hmac(kService, 'aws4_request');
                return kSigning;
            }
            function encodeRFC3986(str: string) {
                // RFC3986 encoding (spaces as %20, not '+', and encode !*'())
                return encodeURIComponent(str).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
            }
            function buildCanonicalQuery(params: Record<string, string>) {
                // Build canonical query string for AWS SigV4
                // Keys and values must be URI-encoded, then sorted by key name
                const pairs = Object.keys(params)
                    .sort() // Sort keys first
                    .map((k) => [encodeRFC3986(k), encodeRFC3986(params[k])]) as Array<[string, string]>;
                return pairs.map(([k, v]) => `${k}=${v}`).join('&');
            }

            // Build canonical request for PUT
            // pathPrefix already includes leading slash and bucket, keyName should not be double-encoded for path separator
            const canonicalUri = `${pathPrefix}/${keyName.split('/').map(encodeRFC3986).join('/')}`;
            const queryParams = {
                'X-Amz-Algorithm': alg,
                'X-Amz-Credential': `${accessKey}/${credentialScope}`,
                'X-Amz-Date': amzDate,
                'X-Amz-Expires': String(ttlSec),
                'X-Amz-SignedHeaders': 'host',
            } as Record<string, string>;
            const canonicalQuery = buildCanonicalQuery(queryParams);
            const canonicalHeaders = `host:${host}\n`;
            const signedHeaders = 'host';
            const payloadHash = 'UNSIGNED-PAYLOAD';
            const canonicalRequest = ['PUT', canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
            const stringToSign = [alg, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
            const signature = createHmac('sha256', signKey(secretKey)).update(stringToSign).digest('hex');
            const putUrl = `${protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;

            // Public GET URL: prefer configured public base, else presign a GET similarly
            let getUrl = publicBase ? `${publicBase.replace(/\/$/, '')}/${keyName}` : '';
            if (!getUrl) {
                const q2Params = {
                    'X-Amz-Algorithm': alg,
                    'X-Amz-Credential': `${accessKey}/${credentialScope}`,
                    'X-Amz-Date': amzDate,
                    'X-Amz-Expires': String(ttlSec),
                    'X-Amz-SignedHeaders': 'host',
                } as Record<string, string>;
                const q2 = buildCanonicalQuery(q2Params);
                const canReq2 = ['GET', canonicalUri, q2, canonicalHeaders, signedHeaders, payloadHash].join('\n');
                const sts2 = [alg, amzDate, credentialScope, sha256Hex(canReq2)].join('\n');
                const sig2 = createHmac('sha256', signKey(secretKey)).update(sts2).digest('hex');
                getUrl = `${protocol}//${host}${canonicalUri}?${q2}&X-Amz-Signature=${sig2}`;
            }

            // Debug: log the signature components
            console.log('[upload] canonicalUri:', canonicalUri);
            console.log('[upload] canonicalQuery:', canonicalQuery);
            console.log('[upload] canonicalRequest hash:', sha256Hex(canonicalRequest));
            console.log('[upload] stringToSign:', stringToSign.replace(/\n/g, '\\n'));
            return json(res, 200, { putUrl, getUrl, key: keyName, expiresAt: Date.now() + ttlSec * 1000 });
        } catch (e: any) {
            console.error('[upload] error:', e?.message || e);
            return json(res, 500, { error: 'server_error' });
        }
    }

    // Home page
    if (req.method === 'GET' && req.url === '/') {
        try {
            const homePagePath = path.join(process.cwd(), 'server', 'index.html');
            const homePage = fs.readFileSync(homePagePath, 'utf-8');
            res.setHeader('content-type', 'text/html');
            res.setHeader('cache-control', 'public, max-age=3600'); // Cache for 1 hour
            res.statusCode = 200;
            return res.end(homePage);
        } catch (e) {
            console.error('[server] failed to serve home page:', (e as Error).message);
            res.statusCode = 500;
            return res.end('Home page not found');
        }
    }

    // Success page for Stripe checkout completion
    if (req.method === 'GET' && req.url === '/success') {
        try {
            const successPagePath = path.join(process.cwd(), 'server', 'success.html');
            const successPage = fs.readFileSync(successPagePath, 'utf-8');
            res.setHeader('content-type', 'text/html');
            res.setHeader('cache-control', 'public, max-age=3600'); // Cache for 1 hour
            res.statusCode = 200;
            return res.end(successPage);
        } catch (e) {
            console.error('[server] failed to serve success page:', (e as Error).message);
            res.statusCode = 500;
            return res.end('Success page not found');
        }
    }

    // Cancel page for Stripe checkout cancellation
    if (req.method === 'GET' && req.url === '/cancel') {
        res.setHeader('content-type', 'text/html');
        res.statusCode = 200;
        return res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Payment Cancelled</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                    .container { background: white; padding: 40px; border-radius: 12px; max-width: 500px; margin: 0 auto; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                    h1 { color: #e11d48; margin-bottom: 20px; }
                    p { color: #6b7280; margin-bottom: 30px; }
                    .btn { background: #3b82f6; color: white; padding: 12px 24px; border: none; border-radius: 8px; text-decoration: none; display: inline-block; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Payment Cancelled</h1>
                    <p>No worries! You can upgrade to Tunnel Chat Pro anytime.</p>
                    <a href="#" onclick="window.close()" class="btn">Close Window</a>
                </div>
            </body>
            </html>
        `);
    }

    // Debug helper: fetch keys (REMOVED for security - was exposing all API keys publicly!)

    // Default 404 for unknown routes
    res.statusCode = 404;
    res.end('not found');
});

// Create WebSocket server for signaling
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch {
            try { ws.send(JSON.stringify({ type: 'error', error: 'bad_json' })); } catch { }
            return;
        }

        const { type } = msg || {};

        // CREATE room (single-peer)
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

        // CREATE multi-peer room (Pro gated by API key)
        if (type === 'create_multi') {
            const { name, key } = msg;
            if (!name || !key) { ws.send(JSON.stringify({ type: 'error', error: 'missing_fields' })); return; }
            if (!hasKey(key)) { ws.send(JSON.stringify({ type: 'error', error: 'pro_required' })); return; }
            if (rooms.has(name)) { ws.send(JSON.stringify({ type: 'error', error: 'room_exists' })); return; }

            const ttlTimer = setTimeout(() => deleteRoom(name), TTL_MS);
            rooms.set(name, {
                offerSocket: ws,
                createdAt: Date.now(),
                ttlMs: TTL_MS,
                ttlTimer,
                candidatesToCreator: [],
                multi: true,
                joiners: new Map(),
            });
            try { ws.send(JSON.stringify({ type: 'created', name, multi: true })); } catch { }
            return;
        }

        // JOIN room
        if (type === 'join') {
            const { name } = msg;
            if (!name) { ws.send(JSON.stringify({ type: 'error', error: 'missing_fields' })); return; }
            const rec = rooms.get(name);
            if (rec) {
                if (rec.multi) {
                    // Assign a peerId and notify creator
                    const peerId = crypto.randomBytes(6).toString('hex');
                    (ws as any).__roomName = name;
                    (ws as any).__peerId = peerId;
                    rec.joiners!.set(peerId, ws);
                    try { rec.offerSocket.send(JSON.stringify({ type: 'join_request', name, peerId })); } catch { }
                    return;
                } else {
                    ws.send(JSON.stringify({ type: 'offer', name, sdp: rec.offerSDP, info: { createdAt: rec.createdAt } }));
                    (ws as any).__roomName = name;
                    return;
                }
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

        // OFFER (per-peer): forward to the specific joiner
        if (type === 'offer' && typeof msg.peerId === 'string') {
            const { name, peerId, sdp } = msg;
            const rec = rooms.get(name);
            if (!rec || !rec.multi) { ws.send(JSON.stringify({ type: 'error', error: 'not_multi' })); return; }
            const target = rec.joiners!.get(peerId);
            if (!target) { ws.send(JSON.stringify({ type: 'error', error: 'peer_not_found' })); return; }
            try { target.send(JSON.stringify({ type: 'offer', name, peerId, sdp })); } catch { }
            return;
        }

        // ANSWER: forward to creator (single) or to creator with peerId (multi)
        if (type === 'answer') {
            const { name, sdp, peerId } = msg;
            const rec = rooms.get(name);
            if (!rec) { ws.send(JSON.stringify({ type: 'not_found', name })); return; }
            if (rec.multi) {
                try { rec.offerSocket.send(JSON.stringify({ type: 'answer', name, peerId, sdp })); } catch { }
                try { ws.send(JSON.stringify({ type: 'ok' })); } catch { }
                return;
            } else {
                try { rec.offerSocket.send(JSON.stringify({ type: 'answer', name, sdp })); }
                finally { deleteRoom(name); }
                try { ws.send(JSON.stringify({ type: 'ok' })); } catch { }
                return;
            }
        }

        // TRICKLE (single): forward candidate to creator while room exists
        if (type === 'candidate' && msg.name && typeof msg.candidate === 'string' && !msg.peerId) {
            const rec = rooms.get(msg.name);
            if (rec) {
                try { rec.offerSocket.send(JSON.stringify({ type: 'candidate', ...msg })); } catch { }
            }
            return;
        }
        // TRICKLE (multi): with peerId route creator<->joiner
        if (type === 'candidate' && msg.name && typeof msg.candidate === 'string' && typeof msg.peerId === 'string') {
            const rec = rooms.get(msg.name);
            if (!rec || !rec.multi) return;
            if (ws === rec.offerSocket) {
                // from creator to joiner
                const target = rec.joiners!.get(msg.peerId);
                if (target) { try { target.send(JSON.stringify({ type: 'candidate', name: msg.name, candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex })); } catch { } }
            } else {
                // from joiner to creator
                try { rec.offerSocket.send(JSON.stringify({ type: 'candidate', name: msg.name, peerId: msg.peerId, candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex })); } catch { }
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

// Start the combined server
server.listen(PORT, () => {
    console.log(`[combined] HTTP + WebSocket server listening on 0.0.0.0:${PORT}`);
    console.log(`[signaling] TTL=${TTL_MS / 1000}s JOIN_WAIT=${JOIN_WAIT_MS / 1000}s TURN_REALM=${TURN_REALM}`);
    console.log(`[billing] STRIPE_WEBHOOK_SECRET set? ${WEBHOOK_SECRET ? 'yes' : 'NO'}`);
    console.log(`[billing] KEYS_PATH ${path.resolve(KEYS_PATH)}`);
    console.log(`[combined] endpoints: GET /, GET /success, GET /cancel, POST /create-checkout-session, POST /webhook, POST /auth/key/request, GET /auth/key/consume, GET /auth/key, GET /auth/turn, WebSocket signaling`);
});
