import readline from 'readline';

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
  /** Set ICE connection state to drive the colored indicator */
  setIceState(state: string): void;
  /** Reset the inactivity countdown (pass total ms; UI will tick down) */
  resetInactivity(totalMs: number): void;
  close(): void;
};

const BOX = {
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  h: '─', v: '│'
};

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

// map ICE state -> indicator color/text
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

export function createUI(tunnelName: string, role: 'creator' | 'joiner'): UI {
  // State
  let status = `${C.fg.yellow}waiting…${C.reset}`;
  let peerMsg = '';
  let youMsg = '';
  let inputBuffer = '';
  let disposed = false;

  let iceState = 'new';
  let inactivityTotalMs: number | null = null;
  let inactivityRemainingMs: number | null = null;
  let inactivityTimer: NodeJS.Timeout | null = null;

  // readline setup
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
  readline.emitKeypressEvents(process.stdin, rl as any);
  if (process.stdin.isTTY) process.stdin.setRawMode?.(true);

  // cursor helpers
  function hideCursor() { process.stdout.write('\x1b[?25l'); }
  function showCursor() { process.stdout.write('\x1b[?25h'); }

  // dims
  function dims() {
    const totalW = clamp(process.stdout.columns || 80, 60, 10000);
    const totalH = clamp(process.stdout.rows || 24, 15, 10000);
    const padding = 1;
    const gutter = 2;
    const titleH = 4; // top bar + hint
    const inputH = 3; // bottom input bar
    const contentH = totalH - titleH - inputH;
    const paneW = Math.floor((totalW - gutter - padding * 2) / 2);
    const leftX = padding;
    const rightX = padding + paneW + gutter;
    return { totalW, totalH, padding, gutter, titleH, inputH, contentH, paneW, leftX, rightX };
  }

  function clearScreen() {
    process.stdout.write('\x1b[2J\x1b[0f'); // clear + home
  }
  function moveTo(x: number, y: number) {
    process.stdout.write(`\x1b[${y + 1};${x + 1}H`);
  }
  function padRight(s: string, w: number) {
    const len = stripAnsi(s).length;
    return s + ' '.repeat(Math.max(0, w - len));
  }
  function drawBox(x: number, y: number, w: number, h: number, title?: string) {
    // top
    moveTo(x, y);
    process.stdout.write(BOX.tl + BOX.h.repeat(w - 2) + BOX.tr);
    if (title) {
      const t = ` ${title} `;
      const start = Math.max(1, Math.floor((w - stripAnsi(t).length) / 2));
      moveTo(x + start, y);
      process.stdout.write(t);
    }
    // sides
    for (let i = 1; i <= h - 2; i++) {
      moveTo(x, y + i);
      process.stdout.write(BOX.v);
      moveTo(x + w - 1, y + i);
      process.stdout.write(BOX.v);
    }
    // bottom
    moveTo(x, y + h - 1);
    process.stdout.write(BOX.bl + BOX.h.repeat(w - 2) + BOX.br);
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
    const { totalW, titleH, inputH, contentH, paneW, leftX, rightX } = dims();
    clearScreen();

    const ind = iceIndicator(iceState);
    const connected = iceState === 'connected' || iceState === 'completed';

    // ── Title / status bar ─────────────────────────────────────────────
    const headerTitle = `${C.bold}${C.fg.white}Tunnel Chat${C.reset}`;
    drawBox(0, 0, totalW, titleH, headerTitle);

    // line 1: brand + tunnel/role + indicator + countdown
    const brand = `${C.bold}${C.fg.cyan}ditch.chat${C.reset}`;
    const tunnel = `${C.dim}tunnel:${C.reset} ${C.fg.magenta}${tunnelName}${C.reset}`;
    const roleStr = `${C.dim}role:${C.reset} ${role === 'creator' ? C.fg.green + 'creator' : C.fg.blue + 'joiner'}${C.reset}`;
    const countdown = `${C.dim}auto-close in:${C.reset} ${fmtCountdown(inactivityRemainingMs)}`;
    const line1 = `${brand}   ${tunnel}   ${roleStr}   ${ind.dot} ${ind.label}   ${countdown}`;

    moveTo(2, 1);
    process.stdout.write(padRight(line1, totalW - 4));

    // line 2: status
    moveTo(2, 2);
    process.stdout.write(padRight(`${C.dim}status:${C.reset} ${status}`, totalW - 4));

    // line 3 (hint): only for creators before connected
    moveTo(2, 3);
    if (role === 'creator' && !connected) {
      const hint = `${C.dim}share:${C.reset} npx tunnel-chat ${C.bold}${C.fg.magenta}${tunnelName}${C.reset}`;
      process.stdout.write(padRight(hint, totalW - 4));
    } else {
      process.stdout.write(padRight(' ', totalW - 4));
    }

    // ── Content area: Peer | You ───────────────────────────────────────
    const paneH = contentH;
    const y0 = titleH;
    drawBox(leftX, y0, paneW, paneH, `${C.bold}${C.fg.blue}Peer${C.reset}`);
    drawBox(rightX, y0, paneW, paneH, `${C.bold}${C.fg.green}You${C.reset}`);

    const innerW = paneW - 2;
    const innerH = paneH - 2;
    const peerLines = wrapText(peerMsg || '—', innerW).slice(-innerH);
    const youLines  = wrapText(youMsg  || '—', innerW).slice(-innerH);

    for (let i = 0; i < innerH; i++) {
      moveTo(leftX + 1, y0 + 1 + i);
      process.stdout.write(padRight(peerLines[i] ?? '', innerW));
    }
    for (let i = 0; i < innerH; i++) {
      moveTo(rightX + 1, y0 + 1 + i);
      process.stdout.write(padRight(youLines[i] ?? '', innerW));
    }

    // ── Input box ──────────────────────────────────────────────────────
    const inputY = y0 + paneH;
    drawBox(0, inputY, totalW, inputH, `${C.bold}${C.fg.yellow}Type + Enter to send${C.reset}`);
    const prompt = `${C.dim}>${C.reset} `;
    const maxInputW = totalW - 4 - stripAnsi(prompt).length;
    const bufShown = stripAnsi(inputBuffer).length <= maxInputW
      ? inputBuffer
      : '…' + inputBuffer.slice(-maxInputW + 1);

    moveTo(2, inputY + 1);
    process.stdout.write(padRight(prompt + bufShown, totalW - 4));

    // put the cursor at the end of the input
    const cursorX = 2 + stripAnsi(prompt + bufShown).length;
    moveTo(cursorX, inputY + 1);
    showCursor();
  }

  // input handling (no history)
  rl.input.on('keypress', (_str: string, key: any) => {
    if (disposed) return;
    const code = key?.name;

    if (key?.sequence === '\u0003') { // Ctrl+C
      cleanupAndExit();
      return;
    }
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
  });

  // resize support
  const onResize = () => render();
  process.stdout.on('resize', onResize);

  let onLineCallback: ((line: string) => void) | null = null;

  function cleanupAndExit() {
    if (disposed) return;
    disposed = true;
    try { showCursor(); } catch {}
    try { process.stdout.removeListener('resize', onResize); } catch {}
    try { rl.close(); } catch {}
    // wipe screen on exit
    process.stdout.write('\x1b[2J\x1b[0f');
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

  // initial paint
  render();

  return {
    promptInput(onLine) { onLineCallback = onLine; },
    showLocal(_name, text) { youMsg = text; render(); },
    showRemote(_name, text) { peerMsg = text; render(); },
    setStatus(text) { status = text; render(); },
    setIceState(state: string) { iceState = state; render(); },
    resetInactivity(totalMs: number) {
      inactivityTotalMs = totalMs;
      inactivityRemainingMs = totalMs;
      startInactivityTicker();
      render();
    },
    close() { cleanupAndExit(); }
  };
}
