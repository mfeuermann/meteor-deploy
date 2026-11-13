/**
 * Runs the handlers of one hook: `localCommand` on this machine, `method(api, nodemiral)` in
 * this process and `remoteCommand` on the servers, in MUP's order (hooks design §4.4–§4.6).
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import type { HookExecutor } from '../core/runner.js';
import { lineSplitter } from '../output/lines.js';

/**
 * Stands in for MUP's `nodemiral` argument of a method hook: comet-deploy has no nodemiral
 * sessions, so any use says what to use instead.
 */
export const NODEMIRAL_STUB: object = new Proxy(
  {},
  {
    get(_target, prop) {
      // Inspecting or awaiting the object (console.log, a returned value) is not a use.
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      throw new CometError('nodemiral is not available in comet-deploy. Use api.runSSHCommand(server, command) instead.');
    },
  },
);

/** The servers a remoteCommand runs on: every server of the config (as MUP), narrowed by `--servers`. */
export function hookServers(ctx: CommandContext): string[] {
  const all = Object.keys(ctx.config.servers ?? {});
  return ctx.serverFilter ? all.filter((s) => ctx.serverFilter!.includes(s)) : all;
}

/**
 * Runs `command` with `/bin/sh -c` in the config directory, as MUP's `execSync` does. stdin is
 * the terminal's, so the command can ask; its output goes line by line through the reporter,
 * which masks the secrets.
 *
 * @throws CometError when the command exits with a non-zero code or is stopped by a signal.
 */
export async function runLocalCommand(ctx: CommandContext, name: string, command: string, o: { spawn?: typeof nodeSpawn } = {}): Promise<void> {
  const spawn = o.spawn ?? nodeSpawn;
  const print = (l: string) => ctx.reporter.info(l);
  const out = lineSplitter(print);
  const err = lineSplitter(print);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: ctx.basePath, env: process.env, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout?.setEncoding('utf8').on('data', (c: string) => out.push(c));
    child.stderr?.setEncoding('utf8').on('data', (c: string) => err.push(c));
    child.once('error', (e) => reject(new CometError(`Hook "${name}" failed: "${command}" could not be started: ${e.message}`)));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  out.flush();
  err.flush();
  if (result.code === 0) return;
  const how = result.code === null ? `was stopped by ${result.signal}` : `exited with code ${result.code}`;
  throw new CometError(`Hook "${name}" failed: "${command}" ${how}.`);
}

/**
 * Runs `command` on every hook server in parallel, without sudo, as MUP's remote hooks do. Each
 * server's output is printed when it finishes. A non-zero exit code or a connection error only
 * warns: MUP never fails a command because of a remote hook.
 */
export async function runRemoteCommand(ctx: CommandContext, name: string, command: string): Promise<void> {
  await Promise.all(
    hookServers(ctx).map(async (s) => {
      let output = '';
      try {
        const conn = await ctx.ssh.get(s);
        const collect = (chunk: string) => void (output += chunk);
        const r = await conn.exec(command, { onStdout: collect, onStderr: collect });
        ctx.reporter.info(`=> output from ${ctx.config.servers[s].host}`);
        if (output) ctx.reporter.info(output.replace(/\n$/, ''));
        if (r.code !== 0) ctx.reporter.warn(`Hook "${name}": the remote command exited with code ${r.code} on server "${s}".`);
      } catch (e) {
        ctx.reporter.warn(`Hook "${name}": the remote command could not run on server "${s}": ${(e as Error).message}`);
      }
    }),
  );
}

/**
 * The runner's executor: one handler of the hook `name`, in MUP's order `localCommand` →
 * `method` → `remoteCommand`. `api` gives the object passed to method hooks (created lazily,
 * so it can refer back to the runner).
 */
export function createHookExecutor(ctx: CommandContext, api: () => unknown): HookExecutor {
  return async (name, h) => {
    if (h.localCommand) {
      ctx.reporter.info(`> Running hook ${name} "${h.localCommand}"`);
      await runLocalCommand(ctx, name, h.localCommand);
    }
    if (typeof h.method === 'function') {
      try {
        await h.method(api(), NODEMIRAL_STUB);
      } catch (e) {
        const err = e as Error;
        if (err?.stack) for (const l of err.stack.split('\n')) ctx.reporter.verboseLine(null, l);
        throw new CometError(`Hook "${name}" failed: ${err?.message ?? String(e)}`);
      }
    }
    if (h.remoteCommand) {
      ctx.reporter.info(`> Running hook ${name} remote command "${h.remoteCommand}"`);
      await runRemoteCommand(ctx, name, h.remoteCommand);
    }
  };
}
