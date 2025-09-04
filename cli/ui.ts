import readline from 'readline';

export type UI = {
  promptInput(onLine: (line: string) => void): void;
  showLocal(name: string, text: string): void;   // not strictly needed; here for symmetry
  showRemote(name: string, text: string): void;  // overwrites the "remote line"
  setStatus(text: string): void;
  close(): void;
};

export function createUI(tunnelName: string, role: 'creator' | 'joiner'): UI {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  readline.emitKeypressEvents(process.stdin, rl as any);
  if (process.stdin.isTTY) process.stdin.setRawMode?.(true);

  let lastRemote = '';
  let status = `tunnel: ${tunnelName} (${role}) — type your message and hit Enter. Ctrl+C to exit.`;

  function render() {
    // Clear screen and redraw three lines
    process.stdout.write('\x1b[2J\x1b[0f'); // clear + home
    console.log(status);
    console.log(`peer: ${lastRemote || '—'}`);
    rl.prompt(true);
  }

  rl.setPrompt('you: ');
  render();

  rl.on('SIGINT', () => { rl.close(); });

  return {
    promptInput(onLine) {
      rl.on('line', (line) => {
        onLine(line.trim());
        rl.prompt(true);
      });
    },
    showLocal(_name, _text) {
      // We don't keep local history; UI is already showing input prompt.
    },
    showRemote(_name, text) {
      lastRemote = text;
      render();
    },
    setStatus(text) {
      status = text;
      render();
    },
    close() {
      rl.close();
      process.exit(0);
    }
  };
}
