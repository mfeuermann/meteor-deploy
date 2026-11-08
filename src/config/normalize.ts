import { homedir } from 'node:os';
import { resolve } from 'node:path';
import cloneDeep from 'lodash/cloneDeep.js';
import defaultsDeep from 'lodash/defaultsDeep.js';
import { defaultBuildLocation, lbPort } from './deterministic.js';
import type { CometOptions, NormalizedConfig, RawConfig } from './types.js';

export const DEFAULT_COMET_OPTIONS: Readonly<CometOptions> = Object.freeze({
  strategy: 'canary',
  transfer: 'auto',
  platform: 'auto',
  keepVersions: 5,
  zeroDowntime: true,
  healthCheck: Object.freeze({ path: '/', maxStatus: 499 }),
  lock: true,
}) as CometOptions;

function expandTilde(p: string): string {
  return p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p;
}

/** Absolute app path, resolved like MUP's `api.resolvePath(basePath, app.path)`. */
export function resolveAppPath(config: { app: { path?: string } }, basePath: string): string {
  return resolve(expandTilde(basePath), expandTilde(config.app.path || ''));
}

// --- ports of MUP 1.5.11 prepareConfig steps (plugins/meteor, mongo, proxy) ---

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
    config.app.buildOptions.cleanBuildLocation = true;
  }
  return config;
}

function prepareMongo(config: RawConfig): RawConfig {
  if (!config.app || !config.mongo) return config;
  config.mongo.version = config.mongo.version || '3.4.24';
  config.app.env = config.app.env || {};
  config.mongo.dbName = config.mongo.dbName || config.app.name.split('.').join('');
  config.app.env.MONGO_URL = `mongodb://mongodb:27017/${config.mongo.dbName}?replicaSet=meteor`;
  if (!config.app.docker) config.app.docker = {};
  if (!config.app.docker.args) config.app.docker.args = [];
  config.app.docker.args.push('--link=mongodb:mongodb');
  return config;
}

function addProxyEnv(config: RawConfig, env: Record<string, any>): Record<string, any> {
  const ssl = config.proxy.ssl;
  env.VIRTUAL_HOST = config.proxy.domains;
  env.HTTPS_METHOD = ssl && ssl.forceSSL ? 'redirect' : 'noredirect';
  if (ssl && ssl.letsEncryptEmail) {
    env.LETSENCRYPT_HOST = config.proxy.domains;
    config.app.env.LETSENCRYPT_EMAIL = ssl.letsEncryptEmail;
  }
  if (config.proxy.loadBalancing) {
    env.PORT = env.PORT || lbPort(config.app.name);
  }
  return env;
}

/**
 * MUP rewrites http:// to https:// when proxy.ssl is set, but its split(':')/join('')
 * drops the port colon (`http://a.com:3000` → `https://a.com3000`). We only swap the scheme.
 */
function normalizeUrl(config: RawConfig): string {
  const url = config.app.env.ROOT_URL;
  if (config.proxy.ssl && typeof url === 'string' && /^http:\/\//i.test(url)) {
    config.app.env.ROOT_URL = 'https://' + url.slice('http://'.length);
  }
  return config.app.env.ROOT_URL;
}

function prepareProxy(config: RawConfig): RawConfig {
  if (!config.app || !config.proxy) return config;
  const swarmEnabled = config.swarm && config.swarm.enabled;
  config.app.env = config.app.env || {};
  config.app.docker = config.app.docker || {};
  config.app.env = addProxyEnv(config, config.app.env);
  if (config.app.servers && config.proxy.loadBalancing) {
    for (const key of Object.keys(config.app.servers)) {
      const privateIp = config.servers?.[key]?.privateIp;
      if (privateIp) config.app.servers[key].bind = privateIp;
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
  let config = cloneDeep(raw);
  // MUP's _normalizeConfig: shallow copy of `meteor` into `app` (nested objects stay shared).
  if (config.meteor && typeof config.app !== 'object') {
    config.app = Object.assign({}, config.meteor);
    config.app.type = 'meteor';
  } else if (typeof config.app === 'object' && config.app !== null && !('type' in config.app)) {
    config.app.type = 'meteor';
  }
  config = prepareMeteor(config, o.basePath);
  config = prepareMongo(config);
  config = prepareProxy(config);
  config.cometDeploy = cometOptions(config.cometDeploy);
  return config as NormalizedConfig;
}
