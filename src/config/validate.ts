import type Joi from 'joi';
import { appSchema, cometSchema, KNOWN_TOP_LEVEL_KEYS, mongoSchema, proxySchema, registrySchema, serversSchema } from './schema.js';
import type { NormalizedConfig, RawConfig } from './types.js';

export interface Issue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export function hasFatal(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

const JOI_OPTIONS: Joi.ValidationOptions = { abortEarly: false, convert: false, allowUnknown: false };

function joiIssues(schema: Joi.Schema, value: unknown, prefix: string, isFatal: (path: string, type: string) => boolean): Issue[] {
  const { error } = schema.validate(value, JOI_OPTIONS);
  if (!error) return [];
  return error.details.map((d) => {
    const rel = d.path.join('.');
    const path = rel ? `${prefix}.${rel}` : prefix;
    const message = d.type === 'object.unknown' ? 'is an unknown property' : d.message.replace(/^"[^"]*" /, '');
    return { path, message, severity: isFatal(path, d.type) ? 'error' : 'warning' };
  });
}

function hasNewline(v: unknown): boolean {
  return typeof v === 'string' && /[\r\n]/.test(v);
}

/**
 * Validates the normalized config with MUP's schemas. Only problems that make a
 * deploy impossible (or are unsupported) are errors; everything MUP tolerates in
 * practice is a warning (spec §7.1).
 */
export function validateConfig(config: NormalizedConfig, raw: RawConfig): Issue[] {
  const issues: Issue[] = [];
  const appKey = raw.meteor && typeof raw.app !== 'object' ? 'meteor' : 'app';
  const err = (path: string, message: string) => issues.push({ path, message, severity: 'error' });
  const warn = (path: string, message: string) => issues.push({ path, message, severity: 'warning' });

  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) warn(key, 'is an unknown property');
  }

  // servers
  if (!config.servers || typeof config.servers !== 'object' || Object.keys(config.servers).length === 0) {
    err('servers', 'is required');
  } else {
    issues.push(
      ...joiIssues(serversSchema, config.servers, 'servers', (path, type) => {
        return type === 'any.required' || /\.(host|username)$/.test(path);
      }),
    );
    for (const [name, s] of Object.entries(config.servers)) {
      if (s?.pem && s.pem.endsWith('.pub')) {
        err(`servers.${name}.pem`, 'Needs to be a path to a private key. The file extension ".pub" is used for public keys.');
      }
    }
  }

  // app / meteor
  const app = config.app;
  if (!app || typeof app !== 'object') {
    err(appKey, 'is required (a "meteor" or "app" section)');
  } else {
    const { type: _type, ...appForSchema } = app;
    const fatalAppPaths = new Set([`${appKey}.name`, `${appKey}.path`, `${appKey}.servers`, `${appKey}.env`, `${appKey}.env.ROOT_URL`]);
    issues.push(...joiIssues(appSchema, appForSchema, appKey, (path) => fatalAppPaths.has(path)));
    if (typeof app.name === 'string' && app.name.includes(' ')) err(`${appKey}.name`, 'has a space');
    for (const name of Object.keys(app.servers ?? {})) {
      if (!config.servers?.[name]) err(`${appKey}.servers.${name}`, `server "${name}" is not defined in "servers"`);
    }
    if (app.ssl !== undefined) {
      err(`${appKey}.ssl`, 'is a deprecated MUP option that comet-deploy does not support. Use the "proxy" section instead.');
    }
    if (app.nginx !== undefined) {
      err(`${appKey}.nginx`, 'is a deprecated MUP option that comet-deploy does not support. Use the "proxy" section instead.');
    }
    if (app.docker?.imageFrontendServer !== undefined || (app as any).dockerImageFrontendServer !== undefined) {
      err(`${appKey}.docker.imageFrontendServer`, 'is a deprecated MUP option that comet-deploy does not support. Use the "proxy" section instead.');
    }
    for (const [k, v] of Object.entries(app.env ?? {})) {
      if (hasNewline(v)) err(`${appKey}.env.${k}`, 'contains a newline, which env.list cannot represent');
    }
    for (const [s, ref] of Object.entries(app.servers ?? {})) {
      for (const [k, v] of Object.entries(ref?.env ?? {})) {
        if (hasNewline(v)) err(`${appKey}.servers.${s}.env.${k}`, 'contains a newline, which env.list cannot represent');
      }
    }
    const rawApp = raw[appKey] ?? {};
    for (const opt of ['prepareBundleLocally', 'useBuildKit']) {
      if (rawApp.docker && opt in rawApp.docker) {
        warn(`${appKey}.docker.${opt}`, 'ignored: comet-deploy always builds locally with BuildKit');
      }
    }
  }

  // mongo
  if (config.mongo) {
    issues.push(...joiIssues(mongoSchema, config.mongo, 'mongo', (_p, type) => type === 'any.required'));
    for (const name of Object.keys(config.mongo.servers ?? {})) {
      if (!config.servers?.[name]) err(`mongo.servers.${name}`, `server "${name}" is not defined in "servers"`);
    }
    const rawMongoUrl = raw[appKey]?.env?.MONGO_URL;
    if (typeof rawMongoUrl === 'string' && (rawMongoUrl.includes('.') || rawMongoUrl.includes('@'))) {
      warn('mongo', 'It looks like app.env.MONGO_URL is for an external database. Remove the `mongo` object to use external databases.');
    }
  }

  // proxy
  if (config.proxy) {
    issues.push(...joiIssues(proxySchema, config.proxy, 'proxy', (path) => path === 'proxy.domains'));
    const port = raw[appKey]?.env?.PORT;
    if (port && port !== 80 && !config.proxy.loadBalancing) warn('proxy', 'app.env.PORT is ignored when using the reverse proxy');
  }

  if (config.privateDockerRegistry) {
    issues.push(...joiIssues(registrySchema, config.privateDockerRegistry, 'privateDockerRegistry', (path) => path === 'privateDockerRegistry.host'));
  }

  if (config.swarm?.enabled) err('swarm.enabled', 'Docker Swarm is not supported by comet-deploy');

  if (Array.isArray(config.plugins) && config.plugins.length > 0) {
    warn('plugins', 'MUP plugins are not supported by comet-deploy and will be ignored');
  }

  if (raw.cometDeploy !== undefined) {
    issues.push(...joiIssues(cometSchema, raw.cometDeploy, 'cometDeploy', (_p, type) => type !== 'object.unknown'));
  }

  return issues;
}
