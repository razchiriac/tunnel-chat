#!/usr/bin/env node
import { exec as execCb } from 'child_process';
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { autoName } from './name.js';
import { TunnelPeer } from './peer.js';
import { createUI } from './ui.js';
const exec = promisify(execCb);

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
  .addHelpText('after', `
Examples:
  npx tunnel-chat                    # Create new tunnel
  npx tunnel-chat my-tunnel          # Join existing tunnel
  npx tunnel-chat --theme matrix     # Use matrix theme

In-chat commands:
  /help or /?        Show help
  /copy              Copy last received file URL to clipboard
  /send <path>       Upload and send a file (Pro)
  /upload            Open file picker to upload (Pro)
  /react <emoji>     Send emoji reaction (Pro)
  /theme <name>      Change theme (Pro)
  /fp                Show connection stats
  /fpkey             Show DTLS fingerprints
  r + Enter          Retry connection (when joining)

Pro features (require TUNNEL_API_KEY):
  • File uploads up to 10MB via secure presigned URLs
  • Emoji reactions and custom themes
  • Multi-peer hubs with --peers option
  • Priority TURN relay servers

Environment variables:
  TUNNEL_API_KEY     Your Pro API key
  TUNNEL_SIGNAL      Signaling server (default: wss://ditch.chat)
  BILLING_SERVER     Billing server (default: https://ditch.chat)
  MAX_UPLOAD_BYTES   Max file size (default: 10485760)

Get Pro access:
  npx tunnel-chat upgrade           # Start payment process
  npx tunnel-chat auth <email>      # Retrieve API key after payment`)
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
      onMessage: (text) => {
        // Render file payloads nicely if received as JSON
        try {
          const obj = JSON.parse(text);
          if (obj && obj.type === 'file' && typeof obj.name === 'string' && typeof obj.url === 'string') {
            const sizeStr = typeof obj.size === 'number' ? ` · ${(obj.size / (1024 * 1024)).toFixed(1)}MB` : '';
            ui.showRemote('peer', `📎 ${obj.name}${sizeStr} → ${obj.url}`);
            // Store last received file URL for /copy command
            (global as any).lastFileUrl = obj.url;
            (global as any).lastFileName = obj.name;
            return;
          }
        } catch { }
        ui.showRemote('peer', text);
      },
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

    // --- File picker and upload helpers ---
    function parseDroppedPath(input: string): string | null {
      let s = (input || '').trim();
      if (!s) return null;
      // Handle macOS/Unix paths with spaces or file:// URLs
      if (s.startsWith('file://')) {
        try { s = decodeURI(s.replace('file://', '')); } catch { }
      }
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
      s = s.replace(/\\ /g, ' ');
      try { if (fs.existsSync(s) && fs.statSync(s).isFile()) return s; } catch { }
      return null;
    }

    async function pickFilePath(): Promise<string | null> {
      try {
        if (process.platform === 'darwin') {
          const script = "POSIX path of (choose file with prompt \"Select a file to upload\")";
          const { stdout } = await exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
          const p = stdout.trim();
          if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
        } else if (process.platform === 'linux') {
          const { stdout: which } = await exec('command -v zenity || true');
          if (which.trim()) {
            const { stdout } = await exec('zenity --file-selection');
            const p = stdout.trim();
            if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
          }
        }
      } catch { }
      return null;
    }

    async function uploadAndSend(filePath: string) {
      if (!proStatus.isPro) { ui.setStatus('This is a Pro feature. Upgrade: npx tunnel-chat upgrade'); return; }
      try {
        const st = fs.statSync(filePath);
        const maxBytes = Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024);
        if (st.size > maxBytes) { ui.setStatus(`Upload too large (max ${(maxBytes / 1024 / 1024).toFixed(1)} MB)`); return; }
        const filename = path.basename(filePath);
        const mime = filename.toLowerCase().endsWith('.png') ? 'image/png'
          : (filename.toLowerCase().endsWith('.jpg') || filename.toLowerCase().endsWith('.jpeg')) ? 'image/jpeg'
            : filename.toLowerCase().endsWith('.gif') ? 'image/gif'
              : 'application/octet-stream';

        const server = process.env.BILLING_SERVER ?? 'https://ditch.chat';
        const key = process.env.TUNNEL_API_KEY || '';
        const res = await fetch(`${server}/auth/upload`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
          body: JSON.stringify({ filename, size: st.size, mime })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          ui.setStatus(`upload auth failed: ${err.error || res.status}`);
          return;
        }
        const info = await res.json() as any;
        if (!info?.putUrl || !info?.getUrl) { ui.setStatus('upload server misconfigured'); return; }

        ui.setStatus(`uploading ${filename}…`);
        const stream = fs.createReadStream(filePath);
        const putOpts: any = { method: 'PUT', headers: { 'content-type': mime, 'content-length': String(st.size) }, body: stream, duplex: 'half' };
        const putRes = await fetch(info.putUrl, putOpts);
        if (!putRes.ok) { ui.setStatus(`upload failed: ${putRes.status}`); return; }

        const payload = { type: 'file', name: filename, size: st.size, url: info.getUrl };
        const sent = peer.send(JSON.stringify(payload));
        if (sent) {
          ui.showLocal('you', `📎 ${filename} · ${(st.size / 1024 / 1024).toFixed(1)}MB → ${info.getUrl}`);
          ui.setStatus('file sent');
        } else {
          ui.setStatus('channel not open yet…');
        }
      } catch (e: any) {
        ui.setStatus(`upload error: ${e?.message || e}`);
      }
    }

    async function handleInput(line: string) {
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
        (peer as any)['ws'].send(JSON.stringify({ type: 'join', name }));
        const proText = proStatus.isPro ? ' [PRO]' : '';
        ui.setStatus(`retrying to join "${name}"${proText} …`);
        return;
      }
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
      if (line.startsWith('/help') || line.trim() === '/?') {
        const helpText = `Available commands:
/help or /?        - Show this help
/copy              - Copy last received file URL to clipboard
/send <path>       - Upload and send a file (Pro)
/upload            - Open file picker to upload (Pro)
/react <emoji>     - Send emoji reaction (Pro)
/theme <name>      - Change theme: default|matrix|solarized|mono (Pro)
/fp                - Show connection stats and encryption info
/fpkey             - Show full DTLS fingerprints for verification

File uploads (Pro):
- Drag and drop a file path into the terminal
- Files up to 10MB supported
- Secure presigned URLs via Cloudflare R2

Pro features require TUNNEL_API_KEY environment variable.
Upgrade: npx tunnel-chat upgrade`;
        ui.setStatus(helpText);
        return;
      }
      if (line.startsWith('/copy')) {
        const lastUrl = (global as any).lastFileUrl;
        const lastName = (global as any).lastFileName;
        if (!lastUrl) { ui.setStatus('No file received yet to copy'); return; }
        try {
          const { spawn } = await import('child_process');
          if (process.platform === 'darwin') {
            const proc = spawn('pbcopy');
            proc.stdin.write(lastUrl);
            proc.stdin.end();
            ui.setStatus(`Copied ${lastName || 'file'} URL to clipboard`);
          } else if (process.platform === 'linux') {
            const proc = spawn('xclip', ['-selection', 'clipboard']);
            proc.stdin.write(lastUrl);
            proc.stdin.end();
            ui.setStatus(`Copied ${lastName || 'file'} URL to clipboard`);
          } else {
            ui.setStatus(`Last file URL: ${lastUrl}`);
          }
        } catch (e) {
          ui.setStatus(`Last file URL: ${lastUrl}`);
        }
        return;
      }
      if (line.startsWith('/send ')) {
        const raw = line.slice(6).trim();
        const p = parseDroppedPath(raw) || raw;
        if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) { ui.setStatus('usage: /send <path-to-file>'); return; }
        await uploadAndSend(p);
        return;
      }
      if (line.trim() === '/upload') {
        const picked = await pickFilePath();
        if (!picked) { ui.setStatus('No picker available. Type: /send <path>'); return; }
        await uploadAndSend(picked);
        return;
      }
      const dropped = parseDroppedPath(line);
      if (dropped) {
        await uploadAndSend(dropped);
        return;
      }
      const ok = peer.send(line);
      if (!ok) ui.setStatus('channel not open yet…');
      else ui.showLocal('you', line);
    }

    ui.promptInput((line) => { void handleInput(line); });
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
