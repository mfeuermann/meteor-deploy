import { setTimeout as delay } from 'node:timers/promises';
import type { CommandContext } from '../../core/context.js';
import { CometError } from '../../core/errors.js';
import { appDir, localImageRepo } from '../../core/naming.js';
import { verboseOutput } from '../../output/lines.js';
import { renderMeteorDestroy, renderMeteorStop } from '../../remote/app-files.js';
import { cometScript } from '../../remote/ops.js';
import type { ConfigCommand } from '../registry.js';

/**
 * `meteor destroy --force` (MUP): waits 5 s, then server by server stops the
 * app, runs MUP's meteor-destroy.sh and removes comet-deploy's extras
 * (version tags, history, lock, config snapshot).
 */
export async function destroyApp(ctx: CommandContext, o: { force: boolean; sleep?: (ms: number) => Promise<unknown> }): Promise<void> {
  const name = ctx.config.app.name;
  if (!o.force) {
    throw new CometError(`This removes "${name}", its config and all its images from the servers.`, {
      hint: 'Run "comet-deploy meteor destroy --force" to confirm.',
    });
  }
  const servers = ctx.appServers();
  ctx.reporter.warn(`Destroying "${name}" on ${servers.join(', ')} in 5 seconds… (Ctrl+C to cancel)`);
  await (o.sleep ?? delay)(5000);
  await ctx.runner.run('meteor.destroy', async () => {
    const stop = await renderMeteorStop(ctx.config);
    const destroy = await renderMeteorDestroy(ctx.config);
    const extra = await cometScript('destroy-extra.sh', { repo: localImageRepo(ctx.config), configDir: `${appDir(ctx.config)}/config` });
    for (const s of servers) {
      ctx.reporter.server(s, 'destroy', 'running');
      const conn = await ctx.ssh.get(s);
      const out = verboseOutput(ctx.reporter, s);
      await conn.runScriptOrThrow(stop, 'Stopping the app', out);
      await conn.runScriptOrThrow(destroy, 'Removing the app', out);
      await conn.runScriptOrThrow(extra, 'Removing comet-deploy data', out);
      ctx.reporter.server(s, 'destroy', 'ok');
    }
  });
}

export const meteorDestroyCommand: ConfigCommand = {
  command: 'destroy',
  describe: false,
  group: 'meteor',
  builder: (y) => y.option('force', { type: 'boolean', describe: 'Confirm that the app should be removed' }),
  run: (ctx, argv) => destroyApp(ctx, { force: !!argv.force }),
};
