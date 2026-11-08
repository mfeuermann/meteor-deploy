/**
 * Access to Meteor Up 1.5.11 (devDependency) as a test oracle. Everything here
 * runs MUP's own code paths so our ports can be compared against them.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

process.env.MUP_SKIP_UPDATE_CHECK = 'true';

const require = createRequire(import.meta.url);
const mupLib = join(dirname(require.resolve('mup/package.json')), 'lib');

// Importing load-plugins registers MUP's bundled plugins (and their config preparers).
require(join(mupLib, 'load-plugins.js'));
const PluginAPI = require(join(mupLib, 'plugin-api.js')).default;

export function mupRequire(rel: string): any {
  return require(join(mupLib, rel));
}

export function createMupApi(configPath: string, opts: { settings?: string; servers?: string } = {}): any {
  const program = { config: configPath, settings: opts.settings, servers: opts.servers, verbose: false };
  return new PluginAPI(dirname(configPath), [], program);
}

/** MUP's normalized config, i.e. `api.getConfig(false)`. */
export async function mupNormalize(configPath: string): Promise<Record<string, any>> {
  const api = createMupApi(configPath);
  const log = console.log;
  console.log = () => {};
  try {
    return JSON.parse(JSON.stringify(api.getConfig(false)));
  } finally {
    console.log = log;
  }
}
