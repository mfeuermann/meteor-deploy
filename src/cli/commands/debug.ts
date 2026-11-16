/**
 * `meteor debug [server] [--port <n>]` (commands design §4.3): see src/remote/debug.ts. Ctrl+C
 * (or SIGTERM) ends the session normally, after the helper container is removed.
 */
import { debugApp } from '../../remote/debug.js';
import { commandWords } from '../pick-server.js';
import type { ConfigCommand } from '../registry.js';

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export const meteorDebugCommand: ConfigCommand = {
  command: 'debug [words..]',
  describe: 'Debug the app with Chrome DevTools, through SSH',
  group: 'meteor',
  strict: false,
  builder: (y) =>
    y
      .positional('words', { type: 'string', array: true, describe: 'Server name (needed with more than one app server)' })
      .option('port', { type: 'number', default: 9229, describe: 'Local port of the debugger on 127.0.0.1' }),
  run: async (ctx, argv) => {
    const ac = new AbortController();
    const onSignal = () => ac.abort();
    for (const s of SIGNALS) process.on(s, onSignal);
    try {
      await debugApp(ctx, { words: commandWords(argv, 'meteor debug'), port: Number(argv.port), signal: ac.signal });
    } finally {
      for (const s of SIGNALS) process.off(s, onSignal);
    }
  },
};
