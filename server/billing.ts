import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import Stripe from 'stripe';

const PORT = Number(process.env.BILLING_PORT || 8888);
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const PRICE_ID = process.env.STRIPE_PRICE_ID || ''; // price_xxx
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const KEYS_PATH = process.env.KEYS_PATH ?? path.join(process.cwd(), 'server', 'keys.json');

const stripe = new Stripe(STRIPE_SECRET, {});

// ---------- keys.json helpers ----------
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

// ---------- utils ----------
function json(res: http.ServerResponse, code: number, obj: any) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.end(JSON.stringify(obj));
}

async function provisionKeyForCustomer(customerId: string | null | undefined) {
  // Generate key and persist; also write into Stripe customer metadata if we have the ID.
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

ensureKeysFile();

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.statusCode = 204; return res.end();
  }

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
        // Normalize customer id if present
        let customerId: string | undefined;

        switch (evt.type) {
          case 'checkout.session.completed':
          case 'checkout.session.async_payment_succeeded': {
            const cs = evt.data.object as Stripe.Checkout.Session;
            customerId = (cs.customer as string) || undefined;
            // Only provision if we haven't already
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
            // no-op for other events
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

  // Debug helper: fetch keys (REMOVED for security - was exposing all API keys publicly!)

  res.statusCode = 404; res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[billing] listening on 0.0.0.0:${PORT}`);
  console.log(`[billing] STRIPE_WEBHOOK_SECRET set? ${WEBHOOK_SECRET ? 'yes' : 'NO'}`);
  console.log(`[billing] KEYS_PATH ${path.resolve(KEYS_PATH)}`);
  console.log(`[billing] endpoints: POST /create-checkout-session, POST /webhook, GET /auth/key`);
});
