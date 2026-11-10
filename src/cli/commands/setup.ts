import type { NormalizedConfig } from '../../config/types.js';
import type { CommandContext } from '../../core/context.js';
import { verboseOutput } from '../../output/lines.js';
import { renderMeteorSetup } from '../../remote/app-files.js';
import { runOnServers } from '../../remote/on-servers.js';
import { renderTemplate } from '../../remote/render.js';
import type { ConfigCommand } from '../registry.js';

/** Keeps the first server of every host (MUP `uniqueSessions`), in the given order. */
export function uniqueHosts(c: NormalizedConfig, servers: string[]): string[] {
  const seen = new Set<string>();
  return servers.filter((s) => {
    const host = c.servers[s]?.host ?? s;
    if (seen.has(host)) return false;
    seen.add(host);
    return true;
  });
}

/** App + mongo + proxy servers (MUP `docker setup`, ref. §3.4), filtered by `--servers`, without duplicates. */
export function dockerServers(ctx: CommandContext): string[] {
  const c = ctx.config;
  const app = Object.keys(c.app.servers ?? {});
  const mongo = Object.keys((c.mongo?.servers as Record<string, unknown>) ?? {});
  const proxy = c.proxy ? Object.keys((c.proxy.servers as Record<string, unknown>) ?? c.app.servers ?? {}) : [];
  const all = [...new Set([...app, ...mongo, ...proxy])];
  return ctx.serverFilter ? all.filter((s) => ctx.serverFilter!.includes(s)) : all;
}

/** `docker setup`: MUP's docker-setup.sh (installs/starts Docker ≥ 18) on every unique host. */
export async function dockerSetup(ctx: CommandContext): Promise<void> {
  await ctx.runner.run('docker.setup', async () => {
    const script = await renderTemplate('mup/docker/docker-setup.sh', { privateRegistry: ctx.config.privateDockerRegistry });
    await ctx.reporter.phase('Docker setup', () =>
      runOnServers(ctx, uniqueHosts(ctx.config, dockerServers(ctx)), 'docker setup', async (conn, s) => {
        await conn.runScriptOrThrow(script, 'Setting up Docker', verboseOutput(ctx.reporter, s));
      }),
    );
  });
}

/** `meteor setup`: MUP's meteor-setup.sh (creates /opt/<name>/{config,tmp}) on the app servers. */
export async function meteorSetup(ctx: CommandContext): Promise<void> {
  await ctx.runner.run('meteor.setup', async () => {
    const script = await renderMeteorSetup(ctx.config);
    await ctx.reporter.phase('App setup', () =>
      runOnServers(ctx, ctx.appServers(), 'app setup', async (conn, s) => {
        await conn.runScriptOrThrow(script, 'Setting up the app directories', verboseOutput(ctx.reporter, s));
      }),
    );
  });
}

/** `setup` (MUP `default.setup` → `docker.setup` → `meteor.setup`). */
export async function setupAll(ctx: CommandContext): Promise<void> {
  await ctx.runner.run('default.setup', async () => {
    for (const part of ['mongo', 'proxy'] as const) {
      if (ctx.config[part]) ctx.reporter.warn(`The "${part}" section is not set up yet: it is planned for phase 2 of comet-deploy.`);
    }
    await dockerSetup(ctx);
    await meteorSetup(ctx);
    ctx.reporter.info('\nNext, deploy the app with: comet-deploy deploy');
  });
}

export const setupCommand: ConfigCommand = {
  command: 'setup',
  describe: 'Install Docker and prepare the servers',
  run: (ctx) => setupAll(ctx),
};

export const meteorSetupCommand: ConfigCommand = {
  command: 'setup',
  describe: false,
  group: 'meteor',
  run: (ctx) => meteorSetup(ctx),
};
