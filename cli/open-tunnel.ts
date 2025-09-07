#!/usr/bin/env node
import { Command } from 'commander';
import { autoName } from './name.js';
import { TunnelPeer } from './peer.js';
import { createUI } from './ui.js';

const DEFAULT_SIGNAL = process.env.TUNNEL_SIGNAL ?? 'wss://ditch.chat';
const DEFAULT_BILLING_SERVER = process.env.BILLING_SERVER ?? 'https://ditch.chat';

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
  .action((nameArg: string | undefined, opts: { signal: string }) => {
    const name = nameArg || autoName();
    const role: 'creator' | 'joiner' = nameArg ? 'joiner' : 'creator';

    // ✅ One UI instance only
    const ui = createUI(name, role);

    if (role === 'creator') {
      ui.setStatus(
        `tunnel: ${name} (creator).
share: npx tunnel-chat@latest ${name}
using signaling: ${opts.signal}
Waiting for peer…`
      );
    } else {
      ui.setStatus(`joining "${name}" … using signaling: ${opts.signal}. Press 'r' then Enter to retry.`);
    }

    const peer = new TunnelPeer({
      name,
      role,
      signalingURL: opts.signal,
      onOpen: () => ui.setStatus(`connected on "${name}". Only last message is displayed.`),
      onMessage: (text) => ui.showRemote('peer', text),
      onStatus: (text) => ui.setStatus(text),
      onClose: () => ui.setStatus('disconnected. press Ctrl+C to exit'),
      onIce: (state) => ui.setIceState(state),
      onTickInactivity: (ms) => ui.resetInactivity(ms)
    });

    ui.promptInput((line) => {
      if (!line) return;
      if (line.trim() === 'r' && role === 'joiner') {
        peer['ws'].send(JSON.stringify({ type: 'join', name }));
        ui.setStatus(`retrying to join "${name}" …`);
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
