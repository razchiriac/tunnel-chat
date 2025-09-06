#!/usr/bin/env node
import { Command } from 'commander';
import { autoName } from './name.js';
import { createUI } from './ui.js';
import { TunnelPeer } from './peer.js';
const DEFAULT_SIGNAL = process.env.TUNNEL_SIGNAL ?? 'wss://ditch.chat';
const program = new Command();
program
    .name('tunnel-chat')
    .description('Ephemeral peer-to-peer tunnel chat from the terminal')
    .argument('[name]', 'optional tunnel name (join this name if provided)')
    .option('--signal <ws>', 'signaling server url (defaults to env TUNNEL_SIGNAL or wss://ditch.chat)', DEFAULT_SIGNAL)
    .action((nameArg, opts) => {
    const name = nameArg || autoName();
    const role = nameArg ? 'joiner' : 'creator';
    // ✅ One UI instance only
    const ui = createUI(name, role);
    if (role === 'creator') {
        ui.setStatus(`tunnel: ${name} (creator).
share: npx tunnel-chat@latest ${name}
using signaling: ${opts.signal}
Waiting for peer…`);
    }
    else {
        ui.setStatus(`joining "${name}" … using signaling: ${opts.signal}`);
    }
    const peer = new TunnelPeer({
        name,
        role,
        signalingURL: opts.signal,
        onOpen: () => ui.setStatus(`connected on "${name}". Only last message is displayed.`),
        onMessage: (text) => ui.showRemote('peer', text),
        onStatus: (text) => ui.setStatus(text),
        onClose: () => ui.close(),
        onIce: (state) => ui.setIceState(state),
        onTickInactivity: (ms) => ui.resetInactivity(ms)
    });
    ui.promptInput((line) => {
        if (!line)
            return;
        const ok = peer.send(line);
        if (!ok)
            ui.setStatus('channel not open yet…');
        else
            ui.showLocal('you', line);
    });
});
program.parseAsync(process.argv).catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
});
