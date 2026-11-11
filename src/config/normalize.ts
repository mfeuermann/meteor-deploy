/**
 * Turns a raw MUP config into the normalized config every command works with. It repeats
 * MUP 1.5.11's normalization step by step (same defaults and mutations, in the same order),
 * so `comet-deploy validate --show` prints what `mup validate --show` prints and the servers
 * end up with the same names, ports and paths. The `cometDeploy` defaults are added on top.
 */
import { resolve } from 'node:path';
import cloneDeep from 'lodash/cloneDeep.js';
import defaultsDeep from 'lodash/defaultsDeep.js';
import { defaultBuildLocation, lbPort } from './deterministic.js';
import { expandTilde } from './load.js';
import type { CometOptions, NormalizedConfig, RawConfig } from './types.js';

/**
 * Defaults for the `cometDeploy` section (frozen; `cometOptions` copies them):
 * - `strategy: 'canary'`: a bad version reaches only the first server; the others keep
 *   running the old one.
 * - `transfer: 'auto'` and `platform: 'auto'`: work without configuration (reverse tunnel,
 *   platform from each server's `uname -m`).
 * - `keepVersions: 5`: a few versions to roll back to without filling the servers' disks.
 * - `zeroDowntime: true`: reserved for deploys behind the proxy (phase 2); no effect yet.
 * - `healthCheck: { path: '/', maxStatus: 499 }`: MUP's deploy check accepts any HTTP answer,
 *   even a 500. comet-deploy fails the check on a 5xx but passes a 4xx, because an app that
 *   answers 401 or 404 on `/` is up.
 * - `lock: true`: two deploys to the same servers cannot interleave.
 */
export const DEFAULT_COMET_OPTIONS: Readonly<CometOptions> = Object.freeze({
  strategy: 'canary',
  transfer: 'auto',
  platform: 'auto',
  keepVersions: 5,
  zeroDowntime: true,
  healthCheck: Object.freeze({ path: '/', maxStatus: 499 }),
  lock: true,
}) as CometOptions;

/** Absolute app path, resolved like MUP's `api.resolvePath(basePath, app.path)`. */
export function resolveAppPath(config: { app: { path?: string } }, basePath: string): string {
  // A path that is not a string is reported by validation; it must not crash here first.
  const path = typeof config.app.path === 'string' ? config.app.path : '';
  return resolve(expandTilde(basePath), expandTilde(path));
}

// --- ports of MUP 1.5.11 prepareConfig steps (plugins/meteor, mongo, proxy) ---
// They mutate `config` in place (it is already a deep copy). The statement order follows
// MUP's code, which also decides the key order of the `validate --show` output.

/**
 * MUP's meteor plugin defaults. `kadirahq/meteord` stays the default image for parity even
 * though comet-deploy cannot build on it yet; 3000 is the port Meteor base images listen on.
 */
function prepareMeteor(config: RawConfig, basePath: string): RawConfig {
  if (!config.app || config.app.type !== 'meteor') return config;
  config.app.docker = defaultsDeep(config.app.docker, {
    image: config.app.dockerImage || 'kadirahq/meteord',
    stopAppDuringPrepareBundle: true,
  });
  delete config.app.dockerImage;
  config.app.docker.imagePort = config.app.docker.imagePort || 3000;
  const appPath = resolveAppPath(config as any, basePath);
  config.app.buildOptions = config.app.buildOptions || {};
  if (config.app.buildOptions.buildLocation === undefined) {
    config.app.buildOptions.buildLocation = defaultBuildLocation(appPath);
    // As in MUP, a defaulted build directory is always cleaned, even with an explicit
    // `cleanBuildLocation: false`.
    config.app.buildOptions.cleanBuildLocation = true;
  }
  return config;
}

/**
 * Whether `app.env` is missing or an object. Another value (`env: 'x'`) is reported by
 * validation; the steps that add env vars skip it instead of crashing on it first.
 */
const envIsObject = (app: RawConfig) => app.env === undefined || app.env === null || typeof app.env === 'object';

/**
 * MUP's built-in MongoDB: `MONGO_URL` is always replaced with the local `mongodb` container
 * (validate.ts warns when the user's URL looks external) and the app is linked to it.
 * comet-deploy does not run the `mongo` section yet, but normalizes it for parity.
 */
function prepareMongo(config: RawConfig): RawConfig {
  if (!config.app || !config.mongo || !envIsObject(config.app)) return config;
  config.mongo.version = config.mongo.version || '3.4.24';
  config.app.env = config.app.env || {};
  // String(): a missing app.name is reported by validation, it must not crash here first.
  config.mongo.dbName = config.mongo.dbName || String(config.app.name ?? '').split('.').join('');
  config.app.env.MONGO_URL = `mongodb://mongodb:27017/${config.mongo.dbName}?replicaSet=meteor`;
  if (!config.app.docker) config.app.docker = {};
  if (!config.app.docker.args) config.app.docker.args = [];
  config.app.docker.args.push('--link=mongodb:mongodb');
  return config;
}

/** The env vars that route the app through MUP's nginx-proxy and Let's Encrypt companion. */
function addProxyEnv(config: RawConfig, env: Record<string, any>): Record<string, any> {
  const ssl = config.proxy.ssl;
  env.VIRTUAL_HOST = config.proxy.domains;
  env.HTTPS_METHOD = ssl && ssl.forceSSL ? 'redirect' : 'noredirect';
  if (ssl && ssl.letsEncryptEmail) {
    env.LETSENCRYPT_HOST = config.proxy.domains;
    env.LETSENCRYPT_EMAIL = ssl.letsEncryptEmail;
  }
  if (config.proxy.loadBalancing) {
    // Deterministic per app name, so MUP and comet-deploy publish the same host port.
    env.PORT = env.PORT || lbPort(String(config.app.name ?? ''));
  }
  return env;
}

/**
 * MUP rewrites http:// to https:// when proxy.ssl is set, but its split(':')/join('')
 * drops the port colon (`http://a.com:3000` → `https://a.com3000`). This is a deliberate
 * difference from MUP: only the scheme is swapped.
 */
function normalizeUrl(config: RawConfig): string {
  const url = config.app.env.ROOT_URL;
  if (config.proxy.ssl && typeof url === 'string' && /^http:\/\//i.test(url)) {
    config.app.env.ROOT_URL = 'https://' + url.slice('http://'.length);
  }
  return config.app.env.ROOT_URL;
}

/**
 * MUP's proxy plugin: adds the proxy env vars, binds load-balanced apps to the servers'
 * private IPs and switches `ROOT_URL` to https when the proxy terminates TLS. comet-deploy
 * does not run the `proxy` section yet, but normalizes it for parity.
 */
function prepareProxy(config: RawConfig): RawConfig {
  if (!config.app || !config.proxy || !envIsObject(config.app)) return config;
  const swarmEnabled = config.swarm && config.swarm.enabled;
  config.app.env = config.app.env || {};
  config.app.docker = config.app.docker || {};
  config.app.env = addProxyEnv(config, config.app.env);
  if (config.app.servers && config.proxy.loadBalancing) {
    for (const key of Object.keys(config.app.servers)) {
      const privateIp = config.servers?.[key]?.privateIp;
      // A null entry is left for validation to report.
      if (privateIp && config.app.servers[key]) config.app.servers[key].bind = privateIp;
    }
  }
  if (!swarmEnabled) config.app.env.VIRTUAL_PORT = config.app.docker.imagePort || 3000;
  config.app.env.HTTP_FORWARDED_COUNT = config.app.env.HTTP_FORWARDED_COUNT || 1;
  if (swarmEnabled) {
    config.app.docker.networks = config.app.docker.networks || [];
    config.app.docker.networks.push('mup-proxy');
  }
  config.app.env.ROOT_URL = normalizeUrl(config);
  return config;
}

/**
 * Fills in the `cometDeploy` defaults. User values are copied without checks (validate.ts
 * reports invalid ones from the raw config); `healthCheck` is merged one level deeper so
 * `healthCheck: { path: '/health' }` keeps the default `maxStatus`.
 */
function cometOptions(raw: unknown): CometOptions {
  const user = raw && typeof raw === 'object' ? (raw as Partial<CometOptions>) : {};
  return {
    ...DEFAULT_COMET_OPTIONS,
    ...user,
    healthCheck: { ...DEFAULT_COMET_OPTIONS.healthCheck, ...(user.healthCheck ?? {}) },
  };
}

/**
 * Normalizes a raw MUP config exactly like MUP 1.5.11 (`_normalizeConfig` +
 * plugin preparers in order meteor → mongo → proxy), plus the `cometDeploy`
 * defaults. The raw object is not mutated.
 */
export function normalizeConfig(raw: RawConfig, o: { basePath: string }): NormalizedConfig {
  // Deep copy: validate.ts compares against the raw values the user wrote (for example the
  // MONGO_URL that prepareMongo overwrites).
  let config = cloneDeep(raw);
  // MUP's _normalizeConfig: shallow copy of `meteor` into `app`. Nested objects stay shared,
  // so changes inside an existing `docker` or `env` object also show under `meteor`, as in
  // MUP's `validate --show` output.
  if (config.meteor && typeof config.app !== 'object') {
    config.app = Object.assign({}, config.meteor);
    config.app.type = 'meteor';
  } else if (typeof config.app === 'object' && config.app !== null && !('type' in config.app)) {
    config.app.type = 'meteor';
  }
  // MUP's plugin order. prepareProxy reads the docker.imagePort that prepareMeteor sets.
  config = prepareMeteor(config, o.basePath);
  config = prepareMongo(config);
  config = prepareProxy(config);
  config.cometDeploy = cometOptions(config.cometDeploy);
  return config as NormalizedConfig;
}
