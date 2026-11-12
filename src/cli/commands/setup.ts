/**
 * `setup`, `meteor setup` and the Docker setup step, plus the server selection helpers that
 * the `docker …` commands share: which servers need Docker, and which of them are the same
 * machine.
 */
import type { NormalizedConfig } from '../../config/types.js';
import type { CommandContext } from '../../core/context.js';
import { verboseOutput } from '../../output/lines.js';
import { renderMeteorSetup } from '../../remote/app-files.js';
import { runOnServers } from '../../remote/on-servers.js';
import { renderTemplate } from '../../remote/render.js';
import { mongoSetup, mongoStart } from '../../mongo/setup.js';
import { proxySetup } from '../../proxy/setup.js';
import type { ConfigCommand } from '../registry.js';

/**
 * Keeps the first server of every machine (MUP `uniqueSessions`), in the given
 * order. A machine is host + SSH port: the same address with another port is
 * another machine behind port forwarding (MUP compares the host only).
 */
export function uniqueHosts(c: NormalizedConfig, servers: string[]): string[] {
  const seen = new Set<string>();
  return servers.filter((s) => {
    const host = `${c.servers[s]?.host ?? s}:${c.servers[s]?.opts?.port ?? 22}`;
    if (seen.has(host)) return false;
    seen.add(host);
    return true;
  });
}

/**
 * App + mongo + proxy servers (the servers MUP's `docker setup` uses), filtered by
 * `--servers`, without duplicates. Without `proxy.servers` the proxy runs on the app servers,
 * as in MUP.
 */
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

/** `setup` (MUP `default.setup` → `docker.setup` → `meteor.setup` → `mongo.*` → `proxy.*`). */
export async function setupAll(ctx: CommandContext, o: { allowMongoVersionChange?: boolean } = {}): Promise<void> {
  // All keys now, so a hook on a later step does not stop setup after Docker was set up.
  const mongoKeys = ctx.config.mongo ? ['mongo.setup', 'mongo.start'] : [];
  const proxyKeys = ctx.config.proxy ? ['proxy.setup', 'proxy.start'] : [];
  ctx.runner.refuseHooks(['default.setup', 'docker.setup', 'meteor.setup', ...mongoKeys, ...proxyKeys]);
  await ctx.runner.run('default.setup', async () => {
    await dockerSetup(ctx);
    await meteorSetup(ctx);
    // MUP's `post.default.setup` hook of the mongo plugin; it runs before the proxy plugin's.
    if (ctx.config.mongo) {
      await mongoSetup(ctx, { allowVersionChange: o.allowMongoVersionChange });
      await mongoStart(ctx, { allowVersionChange: o.allowMongoVersionChange, fromSetup: true });
    }
    // MUP's `post.setup` hook of the proxy plugin.
    if (ctx.config.proxy) await proxySetup(ctx);
    ctx.reporter.info('\nNext, deploy the app with: comet-deploy deploy');
  });
}

/** `--allow-mongo-version-change`, for `setup`, `mongo setup` and `mongo start`. */
export const allowMongoVersionChange = (y: import('yargs').Argv) =>
  y.option('allow-mongo-version-change', {
    type: 'boolean',
    describe: 'Change mongo.version even when comet-deploy thinks MongoDB cannot open the data (skipped or older release series)',
  });

/** `setup`: Docker on every machine, then the app directories on the app servers. */
export const setupCommand: ConfigCommand = {
  command: 'setup',
  describe: 'Install Docker and prepare the servers',
  builder: allowMongoVersionChange,
  run: (ctx, argv) => setupAll(ctx, { allowMongoVersionChange: argv['allow-mongo-version-change'] === true }),
};

/** `meteor setup`: only the app directories, no Docker. */
export const meteorSetupCommand: ConfigCommand = {
  command: 'setup',
  describe: 'Create the app directories on the servers (no Docker)',
  group: 'meteor',
  run: (ctx) => meteorSetup(ctx),
};
