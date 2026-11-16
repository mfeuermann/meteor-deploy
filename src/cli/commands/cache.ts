/**
 * `cache prune [--all] [--registry] [--dry-run]` (commands design §4.5): local build
 * leftovers of the app in the config; see src/build/prune.ts. Connects to no server.
 */
import { pruneCache } from '../../build/prune.js';
import type { ConfigCommand } from '../registry.js';

export const cachePruneCommand: ConfigCommand = {
  command: 'prune',
  describe: 'Remove old local images, the build output and (with --registry) the local registry',
  group: 'cache',
  builder: (y) =>
    y
      .option('all', { type: 'boolean', default: false, describe: 'Also the newest image of each platform: the next deploy builds everything again' })
      .option('registry', { type: 'boolean', default: false, describe: 'Also the local registry and its volume (shared by all apps on this computer)' })
      .option('dry-run', { type: 'boolean', default: false, describe: 'Show what would be removed, remove nothing' }),
  run: (ctx, argv) => pruneCache(ctx, { all: argv.all === true, registry: argv.registry === true, dryRun: argv['dry-run'] === true }),
};
