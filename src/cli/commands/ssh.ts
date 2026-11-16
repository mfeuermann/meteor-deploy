/**
 * `ssh [server] [command..]` (commands design §4.2): the SSH user's login shell on a server, or
 * a command run there like `ssh host command`, with the same SSH settings as every other
 * command. It takes no lock and writes no history.
 */
import type { CommandContext } from '../../core/context.js';
import { CometError } from '../../core/errors.js';
import { runInteractive, type LocalTerminal } from '../../ssh/interactive.js';
import { commandWords, pickServer } from '../pick-server.js';
import type { ConfigCommand } from '../registry.js';

/** Global options of comet-deploy that take the next word as their value. */
const VALUE_OPTIONS = new Set(['--config', '--settings', '--servers']);

/**
 * Puts `--` after the first word that follows `ssh` (the server, or the first word of the
 * command), so that the remote command's own options (`ssh one docker ps -a`) reach the server
 * as typed instead of being read as comet-deploy's, as with OpenSSH. argv stays as it is when
 * the command is not `ssh`, when that word is the last one, or when `--` already follows it.
 * Options before that word (`ssh --servers two uptime`) stay comet-deploy's.
 */
export function protectSshCommand(argv: string[]): string[] {
  const nextWord = (from: number): number => {
    for (let i = from; i < argv.length; i++) {
      const t = argv[i];
      if (t === '--') return -1;
      if (!t.startsWith('-')) return i;
      if (VALUE_OPTIONS.has(t)) i++;
    }
    return -1;
  };
  const cmd = nextWord(0);
  if (cmd < 0 || argv[cmd] !== 'ssh') return argv;
  const first = nextWord(cmd + 1);
  if (first < 0 || first === argv.length - 1 || argv[first + 1] === '--') return argv;
  return [...argv.slice(0, first + 1), '--', ...argv.slice(first + 1)];
}

/**
 * Picks the server from `words` (commands design §4.1; any server of the config, filtered by
 * `--servers`) and opens a shell there, or runs the remaining words joined by spaces. A
 * non-zero exit becomes a CometError with that exit code.
 */
export async function runSsh(ctx: CommandContext, words: string[], term?: LocalTerminal): Promise<void> {
  await ctx.runner.run('default.ssh', async () => {
    const all = Object.keys(ctx.config.servers);
    const candidates = ctx.serverFilter ? all.filter((s) => ctx.serverFilter!.includes(s)) : all;
    const { server, rest } = pickServer({ words, candidates, usage: 'comet-deploy ssh <server>', wordsMayBeCommand: true });
    const conn = await ctx.ssh.get(server);
    const command = rest.join(' ');
    const code = await runInteractive(conn, rest.length ? () => command : null, term);
    if (code === 0) return;
    const message = rest.length ? `"${command}" exited with code ${code} on "${server}".` : `The shell on "${server}" exited with code ${code}.`;
    throw new CometError(message, { exitCode: code });
  });
}

export const sshCommand: ConfigCommand = {
  command: 'ssh [words..]',
  describe: 'Open a shell on a server, or run a command there',
  // Options of the remote command go after `--` and must not be parsed as ours.
  strict: false,
  builder: (y) => y.positional('words', { type: 'string', array: true, describe: 'Server name, then the command to run' }),
  run: (ctx, argv) => runSsh(ctx, commandWords(argv, 'ssh')),
};
