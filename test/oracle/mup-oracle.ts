/**
 * Access to Meteor Up 1.5.11 (devDependency) as a test oracle. Everything here
 * runs MUP's own code paths so our ports can be compared against them.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NormalizedConfig } from '../../src/config/types.js';
import { loadBalancingHosts, PROXY_NAME, proxyDomains } from '../../src/proxy/render.js';

process.env.MUP_SKIP_UPDATE_CHECK = 'true';

const require = createRequire(import.meta.url);
const mupLib = join(dirname(require.resolve('mup/package.json')), 'lib');

// Importing load-plugins registers MUP's bundled plugins (and their config preparers).
require(join(mupLib, 'load-plugins.js'));
const PluginAPI = require(join(mupLib, 'plugin-api.js')).default;

export function mupRequire(rel: string): any {
  return require(join(mupLib, rel));
}

/**
 * What MUP's `upstream.sh` (proxy setup with load balancing) writes into
 * `/opt/mup-nginx-proxy/upstream/<app>` for config `c`: its heredoc, rendered by MUP's ejs and run
 * by bash into a temp file.
 */
export function mupUpstreamFile(c: NormalizedConfig): string {
  const ejs = require('@zodern/ejs');
  const upstreamSh = join(mupLib, 'plugins/proxy/assets/upstream.sh');
  const script = ejs.render(
    readFileSync(upstreamSh, 'utf8'),
    {
      domains: proxyDomains(c),
      name: c.app.name,
      setUpstream: true,
      stickySessions: c.proxy!.stickySessions !== false,
      proxyName: PROXY_NAME,
      port: c.app.env.PORT,
      hostnames: loadBalancingHosts(c),
    },
    { filename: upstreamSh },
  ) as string;
  const start = script.indexOf('cat <<"EOT"');
  const end = script.indexOf('\nEOT\n', start) + '\nEOT\n'.length;
  const out = join(mkdtempSync(join(tmpdir(), 'comet-upstream-')), 'upstream');
  const heredoc = script.slice(start, end).replace('/opt/$PROXYNAME/upstream/$APPNAME', out);
  execFileSync('bash', ['-c', heredoc]);
  return readFileSync(out, 'utf8');
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

/**
 * Runs MUP's own `meteor.envconfig` handler with a captured task list (no SSH)
 * and renders the two `copy` tasks (start.sh, env.list) for one server exactly
 * like MUP's nodemiral `copy` task does: `lodash.merge(vars, hostVars[host])`,
 * then `@zodern/ejs` with `filename` set.
 *
 * Deviation (ruled): MUP merges into a vars object shared by all hosts, so
 * values of one server leak into the next one. We merge into a fresh copy per
 * host, i.e. what MUP produces for a server rendered on its own.
 *
 * Per-server settings paths are resolved by MUP against process.cwd(), so the
 * oracle runs with cwd = `cwd` (default: the config directory).
 */
export async function mupEnvconfigFiles(
  configPath: string,
  settingsPath: string,
  serverName: string,
  opts: { cwd?: string; withoutRegistry?: boolean } = {},
): Promise<{ startSh: string; envList: string }> {
  const { readFileSync } = await import('node:fs');
  const cloneDeep = require('lodash/cloneDeep');
  const merge = require('lodash/merge');
  const ejs = require('@zodern/ejs');
  const handlers = mupRequire('plugins/meteor/command-handlers.js');

  const api = createMupApi(configPath, { settings: settingsPath });
  let captured: any;
  api.runTaskList = async (list: any) => {
    captured = list;
  };
  api.getSessions = () => [];

  const log = console.log;
  const prevCwd = process.cwd();
  console.log = () => {};
  try {
    process.chdir(opts.cwd ?? dirname(configPath));
    const mupConfig = api.getConfig(false);
    // comet-deploy renders start.sh as MUP does without a registry (registry design §4.1).
    if (opts.withoutRegistry) delete mupConfig.privateDockerRegistry;
    await handlers.envconfig(api);
  } finally {
    console.log = log;
    process.chdir(prevCwd);
  }

  const host = api.getConfig(false).servers[serverName].host;
  const render = (destSuffix: string): string => {
    const task = captured._taskQueue.find((t: any) => t.type === 'copy' && t.options.dest.endsWith(destSuffix));
    if (!task) throw new Error(`MUP envconfig produced no copy task for ${destSuffix}`);
    const { src, vars, hostVars } = task.options;
    const merged = merge(cloneDeep(vars), hostVars?.[host]);
    return ejs.render(readFileSync(src, 'utf8'), merged, { filename: src });
  };
  return { startSh: render('/config/start.sh'), envList: render('/config/env.list') };
}
