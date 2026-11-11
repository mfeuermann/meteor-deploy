/**
 * The `docker …` command group (MUP's docker plugin): setup, update, restart, ps, status and
 * the hidden destroy-cluster. Commands that act on Docker run once per machine
 * (`uniqueHosts`) of the app, mongo and proxy servers selected by `--servers`; `status` only
 * reports and checks every entry of `servers`.
 */
import type { CommandContext } from '../../core/context.js';
import { CometError } from '../../core/errors.js';
import { verboseOutput } from '../../output/lines.js';
import { runOnServers } from '../../remote/on-servers.js';
import { shArg } from '../../remote/ops.js';
import { renderTemplate } from '../../remote/render.js';
import type { ConfigCommand } from '../registry.js';
import { logsPassthrough } from './lifecycle.js';
import { dockerServers, dockerSetup, uniqueHosts } from './setup.js';

/** Oldest Docker major version accepted, as in MUP. */
const MIN_DOCKER_MAJOR = 18;

/**
 * Renders one of MUP's docker scripts once and runs it on every machine in parallel, under
 * the runner key `key`. Throws a `CometError` listing the machines where it failed.
 */
async function runTemplateOnHosts(ctx: CommandContext, key: string, template: string, step: string): Promise<void> {
  await ctx.runner.run(key, async () => {
    const script = await renderTemplate(template, { privateRegistry: ctx.config.privateDockerRegistry });
    await runOnServers(ctx, uniqueHosts(ctx.config, dockerServers(ctx)), step, async (conn, s) => {
      await conn.runScriptOrThrow(script, step, verboseOutput(ctx.reporter, s));
    });
  });
}

/**
 * `docker ps [opts]`: `sudo docker ps <opts> 2>&1` on the unique hosts, one after another (MUP).
 * The exit code is not checked: with `2>&1` Docker's own error message is part of the output.
 */
export async function dockerPs(ctx: CommandContext, passthrough: Array<string | number>): Promise<void> {
  // The options come from the command line and end up in a remote shell command: quote them so
  // that values with spaces or shell characters arrive as typed.
  const args = ['ps', ...passthrough.map((a) => shArg(String(a)))].join(' ');
  for (const s of uniqueHosts(ctx.config, dockerServers(ctx))) {
    const r = await (await ctx.ssh.get(s)).exec(`sudo docker ${args} 2>&1`);
    ctx.reporter.info(`[${ctx.config.servers[s]?.host ?? s}] docker ${args}`);
    ctx.reporter.info(r.stdout.trimEnd());
  }
}

/**
 * `docker status`: the Docker server version on all selected servers (MUP: red below 18,
 * warns on mixed versions). Every server is checked and reported; afterwards a `CometError`
 * names the servers that are unreachable or have no usable Docker, so scripts see exit 1.
 */
export async function dockerStatus(ctx: CommandContext): Promise<void> {
  // All entries of `servers`, not only the app servers, as in MUP.
  const all = Object.keys(ctx.config.servers);
  const servers = ctx.serverFilter ? all.filter((s) => ctx.serverFilter!.includes(s)) : all;
  const versions = new Map<string, string>();
  const failed: string[] = [];
  const fail = (s: string, detail: string) => {
    failed.push(s);
    ctx.reporter.server(s, 'docker', 'failed', detail);
  };
  await Promise.all(
    servers.map(async (s) => {
      try {
        // MUP checks for exit code 127 ("command not found") only, but `sudo` answers 1 for a
        // missing command, so the binary is looked up first.
        const r = await (await ctx.ssh.get(s)).exec('command -v docker >/dev/null 2>&1 || exit 127; sudo docker version --format "{{.Server.Version}}"');
        const v = r.stdout.trim();
        if (r.code === 127) return fail(s, 'not installed (run "comet-deploy setup")');
        if (r.code !== 0 || !v) return fail(s, 'not running (run "comet-deploy docker restart")');
        versions.set(s, v);
        const major = Number(v.split('.')[0]);
        if (major < MIN_DOCKER_MAJOR) fail(s, `${v} (comet-deploy needs ${MIN_DOCKER_MAJOR} or newer; run "comet-deploy docker update")`);
        else ctx.reporter.server(s, 'docker', 'ok', v);
      } catch (err) {
        fail(s, (err as Error).message);
      }
    }),
  );
  if (new Set(versions.values()).size > 1) ctx.reporter.warn(`The servers run different Docker versions: ${[...versions].map(([s, v]) => `${s} ${v}`).join(', ')}`);
  if (failed.length) throw new CometError(`Docker is not usable on: ${servers.filter((s) => failed.includes(s)).join(', ')}`);
}

const group = 'docker' as const;

/** The `docker …` subcommands, registered by `main.ts`. */
export const DOCKER_COMMANDS: ConfigCommand[] = [
  { command: 'setup', describe: 'Install or start Docker on the servers', group, run: (ctx) => dockerSetup(ctx) },
  { command: 'update', describe: 'Update Docker on the servers', group, run: (ctx) => runTemplateOnHosts(ctx, 'docker.update', 'mup/docker/docker-update.sh', 'docker update') },
  { command: 'restart', describe: 'Restart the Docker daemon on the servers', group, run: (ctx) => runTemplateOnHosts(ctx, 'docker.restart', 'mup/docker/docker-restart.sh', 'docker restart') },
  {
    command: 'ps',
    describe: 'docker ps on the servers (options pass through)',
    group,
    strict: false,
    run: (ctx, argv) => ctx.runner.run('docker.ps', () => dockerPs(ctx, logsPassthrough(argv, ['docker', 'ps']))),
  },
  { command: 'status', describe: 'Docker version on the servers', group, run: (ctx) => ctx.runner.run('docker.status', () => dockerStatus(ctx)) },
  // MUP's Docker Swarm command. Hidden; it only explains that there is no cluster and exits 0.
  {
    command: 'destroy-cluster',
    describe: false,
    group,
    run: async (ctx) => ctx.reporter.info('Docker Swarm is not supported by comet-deploy; there is no cluster to destroy.'),
  },
];
