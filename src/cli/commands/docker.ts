import type { CommandContext } from '../../core/context.js';
import { verboseOutput } from '../../output/lines.js';
import { runOnServers } from '../../remote/on-servers.js';
import { shArg } from '../../remote/ops.js';
import { renderTemplate } from '../../remote/render.js';
import type { ConfigCommand } from '../registry.js';
import { logsPassthrough } from './lifecycle.js';
import { dockerServers, dockerSetup, uniqueHosts } from './setup.js';

const MIN_DOCKER_MAJOR = 18;

async function runTemplateOnHosts(ctx: CommandContext, key: string, template: string, step: string): Promise<void> {
  await ctx.runner.run(key, async () => {
    const script = await renderTemplate(template, { privateRegistry: ctx.config.privateDockerRegistry });
    await runOnServers(ctx, uniqueHosts(ctx.config, dockerServers(ctx)), step, async (conn, s) => {
      await conn.runScriptOrThrow(script, step, verboseOutput(ctx.reporter, s));
    });
  });
}

/** `docker ps [opts]`: `sudo docker ps <opts> 2>&1` on the unique hosts, one after another (MUP). */
export async function dockerPs(ctx: CommandContext, passthrough: Array<string | number>): Promise<void> {
  const args = ['ps', ...passthrough.map((a) => shArg(String(a)))].join(' ');
  for (const s of uniqueHosts(ctx.config, dockerServers(ctx))) {
    const r = await (await ctx.ssh.get(s)).exec(`sudo docker ${args} 2>&1`);
    ctx.reporter.info(`[${ctx.config.servers[s]?.host ?? s}] docker ${args}`);
    ctx.reporter.info(r.stdout.trimEnd());
  }
}

/** `docker status`: the Docker server version on all selected servers (MUP: red below 18, warns on mixed versions). */
export async function dockerStatus(ctx: CommandContext): Promise<void> {
  const all = Object.keys(ctx.config.servers);
  const servers = ctx.serverFilter ? all.filter((s) => ctx.serverFilter!.includes(s)) : all;
  const versions = new Map<string, string>();
  await Promise.all(
    servers.map(async (s) => {
      try {
        const r = await (await ctx.ssh.get(s)).exec('sudo docker version --format "{{.Server.Version}}"');
        const v = r.stdout.trim();
        if (r.code === 127) return ctx.reporter.server(s, 'docker', 'failed', 'not installed (run "comet-deploy setup")');
        if (r.code !== 0 || !v) return ctx.reporter.server(s, 'docker', 'failed', 'not running (run "comet-deploy docker restart")');
        versions.set(s, v);
        const major = Number(v.split('.')[0]);
        if (major < MIN_DOCKER_MAJOR) ctx.reporter.server(s, 'docker', 'failed', `${v} (comet-deploy needs ${MIN_DOCKER_MAJOR} or newer; run "comet-deploy docker update")`);
        else ctx.reporter.server(s, 'docker', 'ok', v);
      } catch (err) {
        ctx.reporter.server(s, 'docker', 'failed', (err as Error).message);
      }
    }),
  );
  if (new Set(versions.values()).size > 1) ctx.reporter.warn(`The servers run different Docker versions: ${[...versions].map(([s, v]) => `${s} ${v}`).join(', ')}`);
}

const group = 'docker' as const;

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
  {
    command: 'destroy-cluster',
    describe: false,
    group,
    run: async (ctx) => ctx.reporter.info('Docker Swarm is not supported by comet-deploy; there is no cluster to destroy.'),
  },
];
