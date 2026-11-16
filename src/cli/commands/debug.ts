/**
 * `meteor debug [server] [--port <n>]` (commands design §4.3): see src/remote/debug.ts. Ctrl+C
 * (or SIGTERM) ends the session normally, after the helper container is removed; a second one
 * quits at once, as in the rollout commands (src/cli/signals.ts).
 */
import type { Reporter } from '../../output/reporter.js';
import { debugApp } from '../../remote/debug.js';
import { commandWords } from '../pick-server.js';
import type { ConfigCommand } from '../registry.js';

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * The SIGINT/SIGTERM handler of a debug session: the first signal aborts `ac` (the session
 * removes its helper and ends with 0), a second one exits with 130 right away, for a cleanup
 * that hangs on a dropped connection. The helper then stays; the next session removes it.
 */
export function debugSignalHandler(ac: AbortController, reporter: Reporter, exit: (code: number) => void = (code) => process.exit(code)): () => void {
  return () => {
    if (ac.signal.aborted) {
      reporter.warn('Quitting without cleaning up: the next "comet-deploy meteor debug" removes the helper container.');
      exit(130);
      return;
    }
    reporter.info('Stopping the debugger… (press Ctrl+C again to quit immediately)');
    ac.abort();
  };
}

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
    const onSignal = debugSignalHandler(ac, ctx.reporter);
    for (const s of SIGNALS) process.on(s, onSignal);
    try {
      await debugApp(ctx, { words: commandWords(argv, 'meteor debug'), port: Number(argv.port), signal: ac.signal });
    } finally {
      for (const s of SIGNALS) process.off(s, onSignal);
    }
  },
};
