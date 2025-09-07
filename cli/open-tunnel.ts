#!/usr/bin/env node
import { Command } from 'commander';
import { autoName } from './name.js';
import { TunnelPeer } from './peer.js';
import { createUI } from './ui.js';

const DEFAULT_SIGNAL = process.env.TUNNEL_SIGNAL ?? 'wss://ditch.chat';
const DEFAULT_BILLING_SERVER = process.env.BILLING_SERVER ?? 'https://ditch.chat';

// Helper function to validate API key and check Pro status
async function checkProStatus(signalingURL: string): Promise<{ isPro: boolean; keyValid: boolean }> {
  const apiKey = process.env.TUNNEL_API_KEY;

  if (!apiKey) {
    return { isPro: false, keyValid: false };
  }

  try {
    // Use the signaling server's /auth/turn endpoint to validate the key
    const serverURL = signalingURL.replace('wss://', 'https://').replace('ws://', 'http://');

    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    const response = await fetch(`${serverURL}/auth/turn?key=${encodeURIComponent(apiKey)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      // Key is valid - user is Pro
      return { isPro: true, keyValid: true };
    } else if (response.status === 500) {
      // Server error (likely TURN_SECRET not set) but key might be valid
      const errorData = await response.json().catch(() => ({}));
      if (errorData.error === 'TURN_SECRET not set') {
        // Key is valid but server can't generate TURN credentials
        console.warn('⚠️  TURN server not configured, but Pro status enabled.');
        return { isPro: true, keyValid: true };
      } else {
        // Other server error
        console.warn('⚠️  Server error checking Pro status. Using free tier.');
        return { isPro: false, keyValid: false };
      }
    } else {
      // Key is invalid or expired
      console.warn('⚠️  API key is invalid or expired. Pro features disabled.');
      return { isPro: false, keyValid: false };
    }
  } catch (error) {
    // Network error or server unavailable - assume non-Pro but don't show error
    if ((error as Error).name === 'AbortError') {
      console.warn('⚠️  Pro status check timed out. Using free tier.');
    } else {
      console.warn('⚠️  Could not verify Pro status. Using free tier.');
    }
    return { isPro: false, keyValid: false };
  }
}

const program = new Command();

program
  .name('tunnel-chat')
  .description('Ephemeral peer-to-peer tunnel chat from the terminal')
  .argument('[name]', 'optional tunnel name (join this name if provided)')
  .option(
    '--signal <ws>',
    'signaling server url (defaults to env TUNNEL_SIGNAL or wss://ditch.chat)',
    DEFAULT_SIGNAL
  )
  .option('--peers <n>', 'enable Pro multi-peer hub with max peers', (v: string) => Number(v), 0)
  .option('--theme <name>', 'set theme: default|matrix|solarized|mono')
  .action(async (nameArg: string | undefined, opts: { signal: string; peers?: number; theme?: string }) => {
    const name = nameArg || autoName();
    const role: 'creator' | 'joiner' = nameArg ? 'joiner' : 'creator';

    // Check Pro status before creating UI
    const proStatus = await checkProStatus(opts.signal);

    // ✅ One UI instance only - now with Pro status
    const ui = createUI(name, role, proStatus.isPro, opts.theme);

    if (role === 'creator') {
      const proText = proStatus.isPro ? ' [PRO]' : '';
      ui.setStatus(
        `tunnel: ${name} (creator)${proText}.
share: npx tunnel-chat@latest ${name}
using signaling: ${opts.signal}
Waiting for peer…`
      );
    } else {
      const proText = proStatus.isPro ? ' [PRO]' : '';
      ui.setStatus(`joining "${name}"${proText} … using signaling: ${opts.signal}. Press 'r' then Enter to retry.`);
    }

    // If creator with --peers and Pro, create multi-peer room first
    if (role === 'creator' && proStatus.isPro && opts.peers && opts.peers > 1) {
      // Open a control WebSocket to send create_multi
      try {
        const ws = new (await import('ws')).WebSocket(opts.signal);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'create_multi', name, key: process.env.TUNNEL_API_KEY }));
          ui.setStatus(`multi-peer room created: "${name}" (up to ${opts.peers} peers)`);
        });
        ws.on('message', (raw: any) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'join_request' && typeof msg.peerId === 'string') {
              // For simplicity, spin up a dedicated TunnelPeer for this joiner using same name; creator role
              const child = new TunnelPeer({
                name,
                role: 'creator',
                signalingURL: opts.signal,
                apiKey: process.env.TUNNEL_API_KEY,
                onOpen: () => ui.setStatus(`peer ${msg.peerId} connected`),
                onMessage: (text) => ui.showRemote('peer', text),
                onStatus: (t) => ui.setStatus(t),
                onClose: () => ui.setStatus(`peer ${msg.peerId} disconnected`),
                onIce: (s) => ui.setIceState(s),
                onTickInactivity: (ms) => ui.resetInactivity(ms),
                onStats: (s) => ui.setNetworkStats({ pathLabel: s.pathLabel, rttMs: s.rttMs, fingerprintShort: s.remoteFingerprint || s.localFingerprint })
              });
              // Immediately send a per-peer offer via signaling with peerId
              // We reuse the child's internal signaling flow by posting a custom offer message once localDescription is ready
              const postOffer = async () => {
                const offer = await (child as any)['pc'].createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
                await (child as any)['pc'].setLocalDescription(offer);
                (child as any).sendSignal({ type: 'offer', name, peerId: msg.peerId, sdp: (child as any)['pc'].localDescription?.sdp });
              };
              postOffer().catch(() => { });
            }
          } catch { }
        });
        ws.on('close', () => ui.setStatus('hub socket closed'));
      } catch (e) {
        ui.setStatus('failed to create multi-peer room');
      }
    }

    const peer = new TunnelPeer({
      name,
      role,
      signalingURL: opts.signal,
      apiKey: proStatus.isPro ? process.env.TUNNEL_API_KEY : undefined, // Pass API key for premium TURN servers
      onOpen: () => {
        const proText = proStatus.isPro ? ' [PRO]' : '';
        ui.setStatus(`connected on "${name}"${proText}. Showing last message from each sender.`);
      },
      onMessage: (text) => ui.showRemote('peer', text),
      onStatus: (text) => ui.setStatus(text),
      onClose: () => ui.setStatus('disconnected. press Ctrl+C to exit'),
      onIce: (state) => ui.setIceState(state),
      onTickInactivity: (ms) => ui.resetInactivity(ms),
      onStats: (s) => {
        const fpShort = s.remoteFingerprint || s.localFingerprint || undefined;
        ui.setNetworkStats({ pathLabel: s.pathLabel, rttMs: s.rttMs, fingerprintShort: fpShort });
      },
      onReaction: (emoji) => ui.showReaction(emoji)
    });

    ui.promptInput((line) => {
      if (!line) return;
      if (line.startsWith('/theme')) {
        const t = line.replace('/theme', '').trim().toLowerCase();
        if (!proStatus.isPro) { ui.setStatus('This is a Pro feature. Upgrade: npx tunnel-chat upgrade'); return; }
        if (!t) { ui.setStatus('usage: /theme <default|matrix|solarized|mono>'); return; }
        ui.setTheme(t);
        ui.setStatus(`theme set to ${t}`);
        return;
      }
      if (line.trim() === 'r' && role === 'joiner') {
        peer['ws'].send(JSON.stringify({ type: 'join', name }));
        const proText = proStatus.isPro ? ' [PRO]' : '';
        ui.setStatus(`retrying to join "${name}"${proText} …`);
        return;
      }
      // Slash commands (local only)
      if (line.startsWith('/fp')) {
        const snap = (peer as any).getStatsSnapshot?.();
        if (!snap) { ui.setStatus('no stats yet'); return; }
        if (line.trim() === '/fpkey') {
          const fullLocal = snap.localFingerprint || '—';
          const fullRemote = snap.remoteFingerprint || '—';
          const text = `DTLS fingerprints:\nlocal:  ${fullLocal}\nremote: ${fullRemote}`;
          ui.setStatus(text);
        } else {
          ui.setStatus(`path: ${snap.pathLabel}  rtt: ${snap.rttMs ?? '—'} ms  enc: ${snap.remoteFingerprint ? 'present' : '—'}`);
        }
        return;
      }

      if (line.startsWith('/react')) {
        if (!proStatus.isPro) { ui.setStatus('This is a Pro feature. Upgrade: npx tunnel-chat upgrade'); return; }
        const emoji = line.replace('/react', '').trim();
        if (!emoji) { ui.setStatus('usage: /react :emoji:'); return; }
        const okSend = (peer as any)?.send?.(JSON.stringify({ type: 'reaction', emoji }));
        if (!okSend) ui.setStatus('channel not open yet…');
        else ui.showReaction(emoji);
        return;
      }

      const ok = peer.send(line);
      if (!ok) ui.setStatus('channel not open yet…');
      else ui.showLocal('you', line);
    });
  });

// Add upgrade command
program
  .command('upgrade')
  .description('Upgrade to premium and get your API key')
  .option('--server <url>', 'billing server url', DEFAULT_BILLING_SERVER)
  .action(async (opts: { server: string }) => {
    try {
      console.log('🚀 Starting upgrade process...');

      // Call the billing server to create checkout session
      const response = await fetch(`${opts.server}/create-checkout-session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(`Failed to create checkout session: ${error.error || response.statusText}`);
      }

      const data = await response.json();

      if (!data.url) {
        throw new Error('No checkout URL received from server');
      }

      console.log('💳 Please complete your payment at:');
      console.log('');
      console.log(`   ${data.url}`);
      console.log('');
      console.log('After payment, use: npx tunnel-chat auth <your-email>');
      console.log('to retrieve your API key.');

    } catch (error) {
      console.error('❌ Upgrade failed:', (error as Error).message);
      process.exit(1);
    }
  });

// Add auth command  
program
  .command('auth')
  .description('Retrieve your API key using your email')
  .argument('<email>', 'email address used for payment')
  .option('--server <url>', 'billing server url', DEFAULT_BILLING_SERVER)
  .action(async (email: string, opts: { server: string }) => {
    try {
      console.log(`🔑 Retrieving API key for ${email}...`);

      // Call the billing server to get the key by email
      const response = await fetch(`${opts.server}/auth/key?email=${encodeURIComponent(email)}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        if (response.status === 404) {
          throw new Error('No API key found for this email. Make sure you completed the payment process.');
        }
        throw new Error(`Failed to retrieve API key: ${error.error || response.statusText}`);
      }

      const data = await response.json();

      if (!data.key) {
        throw new Error('No API key received from server');
      }

      console.log('✅ API key retrieved successfully!');
      console.log('');
      console.log(`   ${data.key}`);
      console.log('');
      console.log('💡 Save this key securely. You can set it as an environment variable:');
      console.log(`   export TUNNEL_API_KEY="${data.key}"`);

    } catch (error) {
      console.error('❌ Auth failed:', (error as Error).message);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
