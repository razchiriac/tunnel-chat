import crypto from 'crypto';
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

// Initialize Stripe
const stripe = new Stripe(STRIPE_SECRET, {});

// Signaling server types and state
type RoomRecord = {
    offerSDP: string;
    offerSocket: WebSocket;
    createdAt: number;
    ttlMs: number;
    ttlTimer: NodeJS.Timeout;
    candidatesToCreator: any[];
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
                        if (status === 'active') {
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

    // Auth endpoint: retrieve key by email
    if (req.method === 'GET' && req.url?.startsWith('/auth/key')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const email = url.searchParams.get('email');

        if (!email) {
            return json(res, 400, { error: 'email parameter required' });
        }

        try {
            // Search for customer by email in Stripe
            const customers = await stripe.customers.list({
                email: email,
                limit: 1,
            });

            if (customers.data.length === 0) {
                return json(res, 404, { error: 'no_customer_found' });
            }

            const customer = customers.data[0];
            const apiKey = customer.metadata?.ditch_api_key;

            if (!apiKey) {
                return json(res, 404, { error: 'no_api_key_found' });
            }

            // Verify the key still exists in our keys store
            if (!loadKeys().includes(apiKey)) {
                console.log('[billing] key not found in store, removing from customer metadata');
                await stripe.customers.update(customer.id, {
                    metadata: { ...customer.metadata, ditch_api_key: '' }
                });
                return json(res, 404, { error: 'api_key_revoked' });
            }

            console.log('[billing] API key retrieved for email:', email);
            return json(res, 200, { key: apiKey });

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

    // Debug helper: fetch keys (optional; disable in prod)
    if (req.method === 'GET' && req.url === '/keys') {
        return json(res, 200, { path: KEYS_PATH, keys: loadKeys() });
    }

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

        // CREATE room
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

        // JOIN room
        if (type === 'join') {
            const { name } = msg;
            if (!name) { ws.send(JSON.stringify({ type: 'error', error: 'missing_fields' })); return; }
            const rec = rooms.get(name);
            if (rec) {
                ws.send(JSON.stringify({ type: 'offer', name, sdp: rec.offerSDP, info: { createdAt: rec.createdAt } }));
                (ws as any).__roomName = name;
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

// Start the combined server
server.listen(PORT, () => {
    console.log(`[combined] HTTP + WebSocket server listening on 0.0.0.0:${PORT}`);
    console.log(`[signaling] TTL=${TTL_MS / 1000}s JOIN_WAIT=${JOIN_WAIT_MS / 1000}s TURN_REALM=${TURN_REALM}`);
    console.log(`[billing] STRIPE_WEBHOOK_SECRET set? ${WEBHOOK_SECRET ? 'yes' : 'NO'}`);
    console.log(`[billing] KEYS_PATH ${path.resolve(KEYS_PATH)}`);
    console.log(`[combined] endpoints: GET /, GET /success, GET /cancel, POST /create-checkout-session, POST /webhook, GET /auth/key, GET /auth/turn, GET /keys (debug), WebSocket signaling`);
});
