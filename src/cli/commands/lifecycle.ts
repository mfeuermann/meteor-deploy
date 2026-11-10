import type { Argv } from 'yargs';
import type { Strategy } from '../../config/types.js';
import type { CommandContext } from '../../core/context.js';
import { CometError } from '../../core/errors.js';
import { envconfigAll, reconfigPipeline, restartPipeline, startAll, stopAll, type LifecycleOutcome } from '../../deploy/pipeline.js';
import { shArg } from '../../remote/ops.js';
import type { ConfigCommand } from '../registry.js';

const STRATEGIES: Strategy[] = ['canary', 'rolling', 'parallel'];

const strategyOption = (y: Argv) => y.option('strategy', { type: 'string', choices: STRATEGIES, describe: 'Rollout strategy (default: cometDeploy.strategy)' });

/** Options that belong to comet-deploy itself and are never passed to `docker logs`. */
const OWN_OPTIONS = new Set(['_', '$0', 'config', 'settings', 'servers', 'verbose', 'show-hook-names', 'help', 'h', 'version', 'v']);

/**
 * Rebuilds the `docker logs` arguments from the parsed argv like MUP's
 * `filterArgv`: positionals after the command first, then the options.
 * yargs' camelCase copies and comet-deploy's own options are dropped.
 */
export function logsPassthrough(argv: Record<string, unknown>, commandPath: string[]): Array<string | number> {
  const positionals = ((argv._ as Array<string | number>) ?? []).slice(commandPath.length);
  const out: Array<string | number> = [...positionals];
  for (const [key, value] of Object.entries(argv)) {
    if (OWN_OPTIONS.has(key) || /[A-Z]/.test(key) || value === false || value === undefined) continue;
    const flag = key.length > 1 ? `--${key}` : `-${key}`;
    for (const v of Array.isArray(value) ? value : [value]) {
      out.push(flag);
      if (typeof v !== 'boolean') out.push(v as string | number);
    }
  }
  return out;
}

/** `sudo docker logs <args> <app> 2>&1`, every argument shell-escaped. */
export function buildLogsCommand(appName: string, passthrough: Array<string | number>): string {
  return ['sudo docker logs', ...passthrough.map((a) => shArg(String(a))), shArg(appName), '2>&1'].join(' ');
}

function prefixLines(prefix: string, emit: (line: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        emit(prefix + buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    flush() {
      if (buf) emit(prefix + buf);
      buf = '';
    },
  };
}

/** Streams `docker logs` from all app servers at once; every line is prefixed with `[<host>]` like MUP. */
export async function streamLogs(ctx: CommandContext, passthrough: Array<string | number>): Promise<void> {
  const cmd = buildLogsCommand(ctx.config.app.name, passthrough);
  const servers = ctx.appServers();
  const res = await Promise.allSettled(
    servers.map(async (s) => {
      const prefix = `[${ctx.config.servers[s]?.host ?? s}]`;
      const emit = (line: string) => ctx.reporter.info(line);
      const out = prefixLines(prefix, emit);
      const err = prefixLines(prefix, emit);
      try {
        await (await ctx.ssh.get(s)).exec(cmd, { onStdout: out.push, onStderr: err.push });
      } finally {
        out.flush();
        err.flush();
      }
    }),
  );
  const failed = res.flatMap((x, i) => (x.status === 'rejected' ? [`${servers[i]}: ${(x.reason as Error)?.message ?? x.reason}`] : []));
  if (failed.length) throw new CometError(`Could not read the logs:\n${failed.map((f) => `  - ${f}`).join('\n')}`);
}

function assertOk(what: string, o: Pick<LifecycleOutcome, 'results' | 'skipped'>): void {
  const bad = [...o.results.filter((r) => r.status !== 'healthy').map((r) => r.server), ...o.skipped];
  if (bad.length) throw new CometError(`${what} did not complete on: ${bad.join(', ')}`);
}

/** Top-level commands run under MUP's `default.<name>` key, the `meteor` variants without it. */
const asDefault = (name: string, fn: (ctx: CommandContext, argv: Record<string, unknown>) => Promise<void>) => (ctx: CommandContext, argv: Record<string, unknown>) =>
  ctx.runner.run(`default.${name}`, () => fn(ctx, argv));

async function reconfig(ctx: CommandContext, argv: Record<string, unknown>): Promise<void> {
  assertOk('Reconfig', await reconfigPipeline(ctx, { strategy: argv.strategy as Strategy | undefined }));
}

async function restart(ctx: CommandContext, argv: Record<string, unknown>): Promise<void> {
  assertOk('Restart', await restartPipeline(ctx, { strategy: argv.strategy as Strategy | undefined }));
}

async function start(ctx: CommandContext): Promise<void> {
  const results = await ctx.runner.run('meteor.start', () => startAll(ctx));
  assertOk('Start', { results, skipped: [] });
}

async function stop(ctx: CommandContext): Promise<void> {
  await ctx.runner.run('meteor.stop', () => stopAll(ctx));
}

const logs = (commandPath: string[]) => (ctx: CommandContext, argv: Record<string, unknown>) =>
  ctx.runner.run('meteor.logs', () => streamLogs(ctx, logsPassthrough(argv, commandPath)));

const logsDescribe = 'Show the app logs from all servers (docker logs options pass through, e.g. -f --tail 50)';

export const reconfigCommand: ConfigCommand = {
  command: 'reconfig',
  describe: 'Write the env and settings to the servers and restart the app',
  builder: strategyOption,
  run: reconfig,
};

export const restartCommand: ConfigCommand = { command: 'restart', describe: 'Restart the app (with a health check)', builder: strategyOption, run: asDefault('restart', restart) };
export const startCommand: ConfigCommand = { command: 'start', describe: 'Start the app on all servers', run: asDefault('start', start) };
export const stopCommand: ConfigCommand = { command: 'stop', describe: 'Stop the app on all servers', run: asDefault('stop', stop) };
export const logsCommand: ConfigCommand = { command: 'logs', describe: logsDescribe, strict: false, run: asDefault('logs', logs(['logs'])) };

export const meteorRestartCommand: ConfigCommand = { command: 'restart', describe: false, group: 'meteor', builder: strategyOption, run: restart };
export const meteorStartCommand: ConfigCommand = { command: 'start', describe: false, group: 'meteor', run: start };
export const meteorStopCommand: ConfigCommand = { command: 'stop', describe: false, group: 'meteor', run: stop };
export const meteorLogsCommand: ConfigCommand = { command: 'logs', describe: false, group: 'meteor', strict: false, run: logs(['meteor', 'logs']) };
export const meteorEnvconfigCommand: ConfigCommand = { command: 'envconfig', describe: false, group: 'meteor', run: (ctx) => envconfigAll(ctx) };

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
