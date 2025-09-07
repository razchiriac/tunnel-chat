import readline from 'readline';

// Use the terminal's alternate screen so no scrollback remains.
function enterAltScreen() {
  // 1049h = use alt buffer, H = move cursor home
  process.stdout.write('\x1b[?1049h\x1b[H');
  // clear scrollback just in case
  process.stdout.write('\x1b[3J');
}
function leaveAltScreen() {
  // clear screen + scrollback, move home
  process.stdout.write('\x1b[2J\x1b[3J\x1b[0f');
  // 1049l = leave alt buffer
  process.stdout.write('\x1b[?1049l');
}

// ==== tiny color helpers (no deps) ====
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  fg: {
    gray: '\x1b[90m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
  }
};

export type UI = {
  promptInput(onLine: (line: string) => void): void;
  showLocal(name: string, text: string): void;
  showRemote(name: string, text: string): void;
  setStatus(text: string): void;
  setIceState(state: string): void;
  setNetworkStats(info: { pathLabel: string; rttMs?: number; fingerprintShort?: string }): void;
  resetInactivity(totalMs: number): void;
  close(): void;
  showReaction(emoji: string): void;
};

const BOX = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
function stripAnsi(s: string) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const rawLen = stripAnsi(line).length;
    const wLen = stripAnsi(w).length;
    if (rawLen ? rawLen + 1 + wLen <= width : wLen <= width) {
      line = rawLen ? line + ' ' + w : w;
    } else {
      if (line) lines.push(line);
      if (wLen > width) {
        let r = w;
        while (stripAnsi(r).length > width) {
          lines.push(r.slice(0, width));
          r = r.slice(width);
        }
        line = r;
      } else {
        line = w;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function iceIndicator(ice: string): { dot: string; label: string } {
  const s = ice || 'new';
  if (s === 'connected' || s === 'completed') {
    return { dot: `${C.fg.green}●${C.reset}`, label: `${C.fg.green}connected${C.reset}` };
  }
  if (s === 'checking' || s === 'connecting' || s === 'gathering') {
    return { dot: `${C.fg.yellow}●${C.reset}`, label: `${C.fg.yellow}${s}${C.reset}` };
  }
  if (s === 'disconnected' || s === 'failed' || s === 'closed') {
    return { dot: `${C.fg.red}●${C.reset}`, label: `${C.fg.red}${s}${C.reset}` };
  }
  return { dot: `${C.fg.gray}●${C.reset}`, label: `${C.fg.gray}${s}${C.reset}` };
}

export function createUI(tunnelName: string, role: 'creator' | 'joiner', isPro: boolean = false): UI {
  // Create colored title - highlight "Pro" with gold/yellow color for premium feel
  const appTitle = isPro
    ? `Tunnel Chat ${C.fg.yellow}${C.bold}Pro${C.reset}${C.bold}${C.fg.white}`
    : 'Tunnel Chat';

  // State - using conversation history instead of separate peer/you messages
  let status = `${C.fg.yellow}waiting…${C.reset}`;
  let conversation: Array<{ sender: 'peer' | 'you'; message: string; timestamp: Date }> = [];
  let inputBuffer = '';
  let disposed = false;

  let iceState = 'new';
  // Network indicators (fast-path, RTT, encryption fingerprint short)
  let netPath: string = '—';
  let netRtt: string = '—';
  let netFpShort: string = '—';
  let inactivityRemainingMs: number | null = null;
  let inactivityTimer: NodeJS.Timeout | null = null;
  let reactionText: string | null = null;
  let reactionTimer: NodeJS.Timeout | null = null;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
  readline.emitKeypressEvents(process.stdin, rl as any);
  if (process.stdin.isTTY) process.stdin.setRawMode?.(true);

  // cursor helpers
  function hideCursor() { process.stdout.write('\x1b[?25l'); }
  function showCursor() { process.stdout.write('\x1b[?25h'); }

  function dims() {
    const totalW = clamp(process.stdout.columns || 80, 60, 10000);
    const totalH = clamp(process.stdout.rows || 24, 15, 10000);
    const padding = 1;
    const titleH = 4;
    const inputH = 3;
    const contentH = totalH - titleH - inputH;
    // Single conversation pane that spans most of the width
    const conversationW = totalW - padding * 2;
    const conversationX = padding;
    return { totalW, totalH, padding, titleH, inputH, contentH, conversationW, conversationX };
  }

  function clearScreen() { process.stdout.write('\x1b[2J\x1b[0f'); }
  function moveTo(x: number, y: number) { process.stdout.write(`\x1b[${y + 1};${x + 1}H`); }
  function padRight(s: string, w: number) { return s + ' '.repeat(Math.max(0, w - stripAnsi(s).length)); }
  function fmtFpShort(fp?: string): string {
    if (!fp) return '—';
    const cleaned = fp.replace(/[^0-9a-fA-F:]/g, '').toUpperCase();
    const parts = cleaned.split(':').filter(Boolean);
    if (parts.length >= 3) return `${parts[0]}:${parts[1]}…${parts[parts.length - 1]}`;
    return cleaned.slice(0, 8) + '…';
  }

  function drawBox(x: number, y: number, w: number, h: number, title?: string) {
    moveTo(x, y); process.stdout.write(BOX.tl + BOX.h.repeat(w - 2) + BOX.tr);
    if (title) {
      const t = ` ${title} `;
      const start = Math.max(1, Math.floor((w - stripAnsi(t).length) / 2));
      moveTo(x + start, y); process.stdout.write(t);
    }
    for (let i = 1; i <= h - 2; i++) { moveTo(x, y + i); process.stdout.write(BOX.v); moveTo(x + w - 1, y + i); process.stdout.write(BOX.v); }
    moveTo(x, y + h - 1); process.stdout.write(BOX.bl + BOX.h.repeat(w - 2) + BOX.br);
  }

  function fmtCountdown(ms: number | null): string {
    if (ms == null) return '—';
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
  }

  function render() {
    if (disposed) return;
    hideCursor();
    const { totalW, titleH, inputH, contentH, conversationW, conversationX } = dims();
    clearScreen();

    const ind = iceIndicator(iceState);
    const connected = iceState === 'connected' || iceState === 'completed';

    // Title/status - show "Tunnel Chat Pro" for users with pro subscription
    drawBox(0, 0, totalW, titleH, `${C.bold}${C.fg.white}${appTitle}${C.reset}`);
    const brand = `${C.bold}${C.fg.cyan}ditch.chat${C.reset}`;
    const tunnel = `${C.dim}tunnel:${C.reset} ${C.fg.magenta}${tunnelName}${C.reset}`;
    const roleStr = `${C.dim}role:${C.reset} ${role === 'creator' ? C.fg.green + 'creator' : C.fg.blue + 'joiner'}${C.reset}`;
    const countdown = `${C.dim}auto-close in:${C.reset} ${fmtCountdown(inactivityRemainingMs)}`;
    moveTo(2, 1); process.stdout.write(padRight(`${brand}   ${tunnel}   ${roleStr}   ${ind.dot} ${ind.label}   ${countdown}`, totalW - 4));
    moveTo(2, 2); process.stdout.write(padRight(`${C.dim}status:${C.reset} ${status}`, totalW - 4));
    const net = `${C.dim}path:${C.reset} ${netPath}   ${C.dim}RTT:${C.reset} ${netRtt}   ${C.dim}enc:${C.reset} 🔒 ${netFpShort}`;
    moveTo(2, 3); process.stdout.write(padRight(net, totalW - 4));

    // Single conversation pane with messenger-style layout
    const conversationH = contentH;
    const y0 = titleH; // keep conversation start; we already drew 3 header rows
    drawBox(conversationX, y0, conversationW, conversationH, `${C.bold}${C.fg.cyan}Conversation${C.reset}`);

    const innerW = conversationW - 2;
    const innerH = conversationH - 2;

    // Generate conversation lines from the conversation history
    const conversationLines: string[] = [];

    if (conversation.length === 0) {
      conversationLines.push(`${C.dim}No messages yet. Start typing to begin the conversation...${C.reset}`);
    } else {
      // Show only the last message from each sender (peer and you)
      const lastPeerMsg = conversation.filter(msg => msg.sender === 'peer').pop();
      const lastYouMsg = conversation.filter(msg => msg.sender === 'you').pop();

      // Collect the messages to display in chronological order
      const messagesToShow = [];
      if (lastPeerMsg) messagesToShow.push(lastPeerMsg);
      if (lastYouMsg) messagesToShow.push(lastYouMsg);

      // Sort by timestamp to maintain chronological order
      messagesToShow.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      for (const msg of messagesToShow) {
        const time = msg.timestamp.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
        const sender = msg.sender === 'you' ? `${C.fg.green}You${C.reset}` : `${C.fg.blue}Peer${C.reset}`;
        const prefix = `${C.dim}[${time}]${C.reset} ${sender}: `;

        // Calculate available width for message content (subtract prefix width)
        const prefixWidth = stripAnsi(prefix).length;
        const messageWidth = Math.max(20, innerW - prefixWidth);

        // Wrap the message text and add each line
        const wrappedLines = wrapText(msg.message, messageWidth);

        if (wrappedLines.length === 0) {
          conversationLines.push(prefix);
        } else {
          // First line includes the prefix
          conversationLines.push(prefix + wrappedLines[0]);
          // Subsequent lines are indented to align with message content
          const indent = ' '.repeat(prefixWidth);
          for (let i = 1; i < wrappedLines.length; i++) {
            conversationLines.push(indent + wrappedLines[i]);
          }
        }

        // Add a small gap between different messages
        if (msg !== messagesToShow[messagesToShow.length - 1]) {
          conversationLines.push('');
        }
      }
    }

    // Optionally add transient reaction bubble under peer's latest
    if (reactionText) {
      conversationLines.push(`${C.dim}   ↳ reaction:${C.reset} ${reactionText}`);
    }
    // Display the most recent lines that fit in the conversation pane
    const displayLines = conversationLines.slice(-innerH);
    for (let i = 0; i < innerH; i++) {
      moveTo(conversationX + 1, y0 + 1 + i);
      process.stdout.write(padRight(displayLines[i] ?? '', innerW));
    }

    // Input section
    const inputY = y0 + conversationH;
    drawBox(0, inputY, totalW, inputH, `${C.bold}${C.fg.yellow}Type + Enter to send${C.reset}`);
    const prompt = `${C.dim}>${C.reset} `;
    const maxInputW = totalW - 4 - stripAnsi(prompt).length;
    const bufShown = stripAnsi(inputBuffer).length <= maxInputW ? inputBuffer : '…' + inputBuffer.slice(-maxInputW + 1);
    moveTo(2, inputY + 1); process.stdout.write(padRight(prompt + bufShown, totalW - 4));

    const cursorX = 2 + stripAnsi(prompt + bufShown).length;
    moveTo(cursorX, inputY + 1);
    showCursor();
  }

  // --- Input handling: listen on process.stdin (fixes TS type issue) ---
  const onKeypress = (_str: string, key: any) => {
    if (disposed) return;
    const code = key?.name;
    if (key?.sequence === '\u0003') { cleanupAndExit(); return; } // Ctrl+C
    if (code === 'return' || code === 'enter') {
      const msg = inputBuffer.trim();
      inputBuffer = '';
      if (msg) onLineCallback?.(msg);
      render();
      return;
    }
    if (code === 'backspace') {
      inputBuffer = inputBuffer.slice(0, -1);
      render();
      return;
    }
    if (key?.sequence && !key.ctrl && !key.meta) {
      inputBuffer += key.sequence;
      render();
    }
  };
  (process.stdin as any).on('keypress', onKeypress);

  // resize support
  const onResize = () => render();
  process.stdout.on('resize', onResize);

  let onLineCallback: ((line: string) => void) | null = null;

  function cleanupAndExit() {
    if (disposed) return;
    disposed = true;
    try { process.stdout.removeListener('resize', onResize); } catch { }
    try { (process.stdin as any).removeListener('keypress', onKeypress); } catch { }
    try { rl.close(); } catch { }

    try { process.stdout.write('\x1b[?25h'); } catch { } // show cursor
    try { leaveAltScreen(); } catch { }
    process.exit(0);
  }

  function startInactivityTicker() {
    if (inactivityTimer) clearInterval(inactivityTimer);
    if (inactivityRemainingMs == null) return;
    inactivityTimer = setInterval(() => {
      if (inactivityRemainingMs == null) return;
      inactivityRemainingMs = Math.max(0, inactivityRemainingMs - 1000);
      render();
    }, 1000);
  }

  const safeExit = () => cleanupAndExit();
  process.on('SIGINT', safeExit);
  process.on('SIGTERM', safeExit);
  process.on('uncaughtException', (e) => { try { console.error(e?.message || e); } catch { } finally { safeExit(); } });
  process.on('exit', () => { try { leaveAltScreen(); } catch { } });

  enterAltScreen();
  // initial paint
  render();

  return {
    promptInput(onLine) { onLineCallback = onLine; },
    // Only keep the last message from each sender to match desired UX
    showLocal(_name, text) {
      // Remove any previous local message, then add the latest
      conversation = conversation.filter(m => m.sender !== 'you');
      conversation.push({ sender: 'you', message: text, timestamp: new Date() });
      render();
    },
    showRemote(_name, text) {
      // Remove any previous peer message, then add the latest
      conversation = conversation.filter(m => m.sender !== 'peer');
      conversation.push({ sender: 'peer', message: text, timestamp: new Date() });
      render();
    },
    setStatus(text) { status = text; render(); },
    setIceState(state: string) { iceState = state; render(); },
    setNetworkStats(info) {
      netPath = info.pathLabel || '—';
      netRtt = typeof info.rttMs === 'number' ? `${info.rttMs} ms` : '—';
      netFpShort = info.fingerprintShort || '—';
      render();
    },
    resetInactivity(totalMs: number) {
      inactivityRemainingMs = totalMs;
      startInactivityTicker();
      render();
    },
    showReaction(emoji: string) {
      if (reactionTimer) clearTimeout(reactionTimer);
      reactionText = emoji;
      render();
      reactionTimer = setTimeout(() => { reactionText = null; render(); }, 2500);
    },
    close() { cleanupAndExit(); }
  };
}
