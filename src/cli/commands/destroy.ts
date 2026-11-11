/**
 * `meteor destroy --force`: removes the app from the app servers, i.e. everything MUP's
 * `meteor destroy` removes plus what only comet-deploy creates. Docker and other apps stay.
 */
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
 *
 * Without `force` it only throws a `CometError` that says what would be removed. The first
 * server that fails stops the command before the next one is touched. `o.sleep` replaces the
 * 5 s wait in tests.
 */
export async function destroyApp(ctx: CommandContext, o: { force: boolean; sleep?: (ms: number) => Promise<unknown> }): Promise<void> {
  const name = ctx.config.app.name;
  if (!o.force) {
    throw new CometError(`This removes "${name}", its config and all its images from the servers.`, {
      hint: 'Run "comet-deploy meteor destroy --force" to confirm.',
    });
  }
  const servers = ctx.appServers();
  // No signal handler is installed here, so Ctrl+C during the wait ends the process before
  // anything is removed.
  ctx.reporter.warn(`Destroying "${name}" on ${servers.join(', ')} in 5 seconds… (Ctrl+C to cancel)`);
  await (o.sleep ?? delay)(5000);
  await ctx.runner.run('meteor.destroy', async () => {
    // All scripts are rendered before the first server is touched, so a template error
    // cannot leave some servers destroyed and others not.
    const stop = await renderMeteorStop(ctx.config);
    const destroy = await renderMeteorDestroy(ctx.config);
    const extra = await cometScript('destroy-extra.sh', { repo: localImageRepo(ctx.config), configDir: `${appDir(ctx.config)}/config` });
    // One server at a time, like MUP. meteor-destroy.sh removes only the :latest, :previous
    // and :build tags; destroy-extra.sh then removes the version tags MUP does not know.
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

/** `meteor destroy [--force]`, as in MUP there is no top-level `destroy`. */
export const meteorDestroyCommand: ConfigCommand = {
  command: 'destroy',
  describe: 'Stop the app and remove it from the servers',
  group: 'meteor',
  builder: (y) => y.option('force', { type: 'boolean', describe: 'Confirm that the app should be removed' }),
  run: (ctx, argv) => destroyApp(ctx, { force: !!argv.force }),
};
