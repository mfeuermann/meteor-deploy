/**
 * App lifecycle commands: `reconfig`, `restart`, `start`, `stop`, `logs`, their
 * `meteor …` variants and `meteor envconfig`. `reconfig` and `restart` lock the servers, roll
 * out by strategy with a health check and can be aborted with Ctrl+C; `start`, `stop` and
 * `logs` work on all app servers in parallel, without a lock.
 */
import type { CommandContext } from '../../core/context.js';
import { CometError } from '../../core/errors.js';
import { lineSplitter } from '../../output/lines.js';
import { envconfigAll, reconfigPipeline, restartPipeline, startAll, stopAll } from '../../deploy/pipeline.js';
import { shArg } from '../../remote/ops.js';
import type { ConfigCommand } from '../registry.js';
import { assertAllHealthy, rolloutArgs, rolloutOptions } from '../rollout.js';
import { withAbortOnSignals } from '../signals.js';

/**
 * Options that belong to comet-deploy itself and are never passed to `docker logs`
 * (`_` and `$0` are yargs internals, `h` and `v` the aliases of help and version).
 */
const OWN_OPTIONS = new Set(['_', '$0', 'config', 'settings', 'servers', 'verbose', 'show-hook-names', 'help', 'h', 'version', 'v']);

/**
 * Rebuilds the `docker logs` arguments from the parsed argv like MUP's
 * `filterArgv`: positionals after the command first, then the options.
 * yargs' camelCase copies and comet-deploy's own options are dropped.
 *
 * `commandPath` is the command as typed (`['logs']`, `['meteor', 'logs']`, `['docker', 'ps']`);
 * its words are removed from the positionals. A `true` option becomes a bare flag, `false`
 * is dropped, and an option given twice is repeated. Also used by `docker ps`.
 */
export function logsPassthrough(argv: Record<string, unknown>, commandPath: string[]): Array<string | number> {
  const positionals = ((argv._ as Array<string | number>) ?? []).slice(commandPath.length);
  const out: Array<string | number> = [...positionals];
  for (const [key, value] of Object.entries(argv)) {
    // yargs adds a camelCase copy of every dashed option (`--since-time` also as `sinceTime`).
    // Docker's options are all lowercase, so a key with an uppercase letter is such a copy.
    if (OWN_OPTIONS.has(key) || /[A-Z]/.test(key) || value === false || value === undefined) continue;
    const flag = key.length > 1 ? `--${key}` : `-${key}`;
    for (const v of Array.isArray(value) ? value : [value]) {
      out.push(flag);
      if (typeof v !== 'boolean') out.push(v as string | number);
    }
  }
  return out;
}

/**
 * `sudo docker logs <args> <app> 2>&1`, every argument shell-escaped (they come from the
 * command line and run in a remote shell). `2>&1` as in MUP: `docker logs` replays the
 * container's stderr on its own stderr, and one stream keeps the lines in their order.
 */
export function buildLogsCommand(appName: string, passthrough: Array<string | number>): string {
  return ['sudo docker logs', ...passthrough.map((a) => shArg(String(a))), shArg(appName), '2>&1'].join(' ');
}

/**
 * Streams `docker logs` from all app servers at once; every line is prefixed with `[<host>]`
 * like MUP. The exit code of `docker logs` is not checked (its error message is in the output); only a
 * server that cannot be reached fails, and all such servers are reported together in one
 * `CometError` after the others have finished.
 */
export async function streamLogs(
  ctx: CommandContext,
  passthrough: Array<string | number>,
  o: { container?: string; servers?: string[] } = {},
): Promise<void> {
  const cmd = buildLogsCommand(o.container ?? ctx.config.app.name, passthrough);
  const servers = o.servers ?? ctx.appServers();
  const res = await Promise.allSettled(
    servers.map(async (s) => {
      const prefix = `[${ctx.config.servers[s]?.host ?? s}]`;
      const emit = (line: string) => ctx.reporter.info(line);
      // One line buffer per stream, so that partial lines of stdout and stderr never mix.
      const out = lineSplitter((l) => emit(prefix + l));
      const err = lineSplitter((l) => emit(prefix + l));
      try {
        // `logs -f` never ends: print the lines, do not collect them.
        await (await ctx.ssh.get(s)).exec(cmd, { onStdout: out.push, onStderr: err.push, collect: false });
      } finally {
        out.flush();
        err.flush();
      }
    }),
  );
  const failed = res.flatMap((x, i) => (x.status === 'rejected' ? [`${servers[i]}: ${(x.reason as Error)?.message ?? x.reason}`] : []));
  if (failed.length) throw new CometError(`Could not read the logs:\n${failed.map((f) => `  - ${f}`).join('\n')}`);
}

/**
 * Top-level commands run under MUP's `default.<name>` key, the `meteor` variants without it.
 * The key decides which hooks belong to the command, and the runner refuses a command that
 * has one (hooks are not supported yet).
 */
const asDefault = (name: string, fn: (ctx: CommandContext, argv: Record<string, unknown>) => Promise<void>) => (ctx: CommandContext, argv: Record<string, unknown>) =>
  ctx.runner.run(`default.${name}`, () => fn(ctx, argv));

/**
 * `reconfig`. Not wrapped in `asDefault`: the pipeline runs MUP's whole key chain itself
 * (`default.reconfig` → `meteor.envconfig` → `meteor.start`).
 */
async function reconfig(ctx: CommandContext, argv: Record<string, unknown>): Promise<void> {
  assertAllHealthy('Reconfig', await withAbortOnSignals(ctx.reporter, (signal) => reconfigPipeline(ctx, rolloutArgs(argv), { signal })));
}

/** Stop, start and health check per server by strategy; the pipeline runs `meteor.restart`. */
async function restart(ctx: CommandContext, argv: Record<string, unknown>): Promise<void> {
  assertAllHealthy('Restart', await withAbortOnSignals(ctx.reporter, (signal) => restartPipeline(ctx, rolloutArgs(argv), { signal })));
}

/** `meteor.start` with a health check on all app servers; throws if one did not come up healthy. */
async function start(ctx: CommandContext): Promise<void> {
  const results = await ctx.runner.run('meteor.start', () => startAll(ctx));
  assertAllHealthy('Start', { results, skipped: [] });
}

/** `meteor.stop` on all app servers. As in MUP this removes the container; `start` recreates it. */
async function stop(ctx: CommandContext): Promise<void> {
  await ctx.runner.run('meteor.stop', () => stopAll(ctx));
}

/** `meteor.logs`; `commandPath` is how the command was typed, so its words are not passed on. */
const logs = (commandPath: string[]) => (ctx: CommandContext, argv: Record<string, unknown>) =>
  ctx.runner.run('meteor.logs', () => streamLogs(ctx, logsPassthrough(argv, commandPath)));

const logsDescribe = 'Show the app logs from all servers (docker logs options pass through, e.g. -f --tail 50)';

/** `reconfig`: writes start.sh and env.list from the current config and restarts by strategy. */
export const reconfigCommand: ConfigCommand = {
  command: 'reconfig',
  describe: 'Write the env and settings to the servers and restart the app',
  builder: rolloutOptions,
  run: reconfig,
};

// Top-level `restart`, `start`, `stop` and `logs`. `logs` is not strict, so that unknown
// options reach `docker logs`.
export const restartCommand: ConfigCommand = { command: 'restart', describe: 'Restart the app (with a health check)', builder: rolloutOptions, run: asDefault('restart', restart) };
export const startCommand: ConfigCommand = { command: 'start', describe: 'Start the app on all servers', run: asDefault('start', start) };
export const stopCommand: ConfigCommand = { command: 'stop', describe: 'Stop the app on all servers', run: asDefault('stop', stop) };
export const logsCommand: ConfigCommand = { command: 'logs', describe: logsDescribe, strict: false, run: asDefault('logs', logs(['logs'])) };

// The `meteor …` variants: the same commands without the `default.<name>` key. There is
// no `meteor reconfig`, as in MUP.
export const meteorRestartCommand: ConfigCommand = { command: 'restart', describe: 'Restart the app (by strategy)', group: 'meteor', builder: rolloutOptions, run: restart };
export const meteorStartCommand: ConfigCommand = { command: 'start', describe: 'Start the app', group: 'meteor', run: start };
export const meteorStopCommand: ConfigCommand = { command: 'stop', describe: 'Stop the app', group: 'meteor', run: stop };
export const meteorLogsCommand: ConfigCommand = { command: 'logs', describe: 'Show the app logs (docker logs options pass through)', group: 'meteor', strict: false, run: logs(['meteor', 'logs']) };
/** `meteor envconfig`: writes start.sh and env.list, no restart, lock or history. */
export const meteorEnvconfigCommand: ConfigCommand = { command: 'envconfig', describe: 'Upload start.sh and env.list without restarting', group: 'meteor', run: (ctx) => envconfigAll(ctx) };

/** All commands of this module, registered by `main.ts`. */
export const LIFECYCLE_COMMANDS: ConfigCommand[] = [
  reconfigCommand,
  restartCommand,
  startCommand,
  stopCommand,
  logsCommand,
  meteorRestartCommand,
  meteorStartCommand,
  meteorStopCommand,
  meteorLogsCommand,
  meteorEnvconfigCommand,
];
