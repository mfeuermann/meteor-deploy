/**
 * Validates the normalized config with MUP's schemas plus the comet-deploy specific checks,
 * and sorts each problem into an error or a warning. MUP prints problems and continues;
 * comet-deploy stops a command on errors (createContext in core/context.ts) and only prints
 * warnings, so configs that work with MUP keep working.
 */
import type Joi from 'joi';
import { appSchema, cometSchema, KNOWN_TOP_LEVEL_KEYS, mongoSchema, proxySchema, registrySchema, serversSchema } from './schema.js';
import { builtInMongoProblem } from '../mongo/rules.js';
import type { NormalizedConfig, RawConfig } from './types.js';
import { hookIssues } from '../hooks/registry.js';

/** One validation problem, printed as `<path> <message>`. */
export interface Issue {
  /** Dotted config path such as `app.env.ROOT_URL` (`meteor.…` for a `meteor` section). */
  path: string;
  /** Message without the path, e.g. `is required`. */
  message: string;
  /** `error` stops every command that needs the config; `warning` is only printed. */
  severity: 'error' | 'warning';
}

/** Whether any issue is an error. */
export function hasFatal(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

// As in MUP: report every problem, no type coercion ('3000' is not a number), and report
// unknown keys.
const JOI_OPTIONS: Joi.ValidationOptions = { abortEarly: false, convert: false, allowUnknown: false };

/**
 * Runs a schema and maps Joi's details to issues under `prefix`. Joi's leading `"label" ` is
 * stripped from the message because the full path is printed in front of it, and unknown
 * keys use MUP's wording. `isFatal` decides the severity per problem.
 */
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

/** env.list holds one unquoted `KEY=value` per line, so a value cannot contain a newline. */
function hasNewline(v: unknown): boolean {
  return typeof v === 'string' && /[\r\n]/.test(v);
}

/** Error text for MUP's pre-1.4 TLS/nginx options, which the `proxy` section replaced. */
const LEGACY_PROXY_OPTION =
  'is a deprecated MUP option that comet-deploy does not support. MUP replaced it with the "proxy" section: ' +
  'move the domain and certificate settings there, or keep deploying this app with MUP.';

/**
 * Validates the normalized config with MUP's schemas. Only problems that make a deploy
 * impossible, or options comet-deploy does not support, are errors. Everything MUP tolerates
 * in practice (unknown keys such as extra ssh2 `opts`, type differences) is a warning, so a
 * config that deploys with MUP is not refused over details.
 *
 * `raw` is the config as the user wrote it. Some checks need it because normalization
 * overwrites or adds the value they look at.
 */
export function validateConfig(config: NormalizedConfig, raw: RawConfig): Issue[] {
  const issues: Issue[] = [];
  // The section normalization used for `app`, so paths match what the user wrote.
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
      // Fatal: a missing key or a bad host/username, which make the SSH connection impossible.
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
    // `type` is not checked: normalization sets it, and only `meteor` apps are deployed.
    const { type: _type, ...appForSchema } = app;
    const fatalAppPaths = new Set([`${appKey}.name`, `${appKey}.path`, `${appKey}.servers`, `${appKey}.env`, `${appKey}.env.ROOT_URL`]);
    issues.push(...joiIssues(appSchema, appForSchema, appKey, (path) => fatalAppPaths.has(path)));
    if (typeof app.name === 'string' && app.name.includes(' ')) err(`${appKey}.name`, 'has a space');
    // The schema only requires ROOT_URL inside `env`; without any `env` the app could not start
    // (and start.sh / env.list could not be rendered).
    if (app.env === undefined) err(`${appKey}.env.ROOT_URL`, 'is required');
    for (const name of Object.keys(app.servers ?? {})) {
      if (!config.servers?.[name]) err(`${appKey}.servers.${name}`, `server "${name}" is not defined in "servers"`);
    }
    // Deprecated since MUP 1.4 in favor of the `proxy` section. They change how the app is
    // served, so ignoring them would deploy something different from what MUP deploys.
    if (app.ssl !== undefined) {
      err(`${appKey}.ssl`, LEGACY_PROXY_OPTION);
    }
    if (app.nginx !== undefined) {
      err(`${appKey}.nginx`, LEGACY_PROXY_OPTION);
    }
    if (app.docker?.imageFrontendServer !== undefined) err(`${appKey}.docker.imageFrontendServer`, LEGACY_PROXY_OPTION);
    if ((app as any).dockerImageFrontendServer !== undefined) err(`${appKey}.dockerImageFrontendServer`, LEGACY_PROXY_OPTION);
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
    // MUP's check, on the raw value: prepareMongo always replaces MONGO_URL with the
    // built-in database, which would silently ignore the user's external one.
    const rawMongoUrl = raw[appKey]?.env?.MONGO_URL;
    if (typeof rawMongoUrl === 'string' && (rawMongoUrl.includes('.') || rawMongoUrl.includes('@'))) {
      warn('mongo', 'It looks like app.env.MONGO_URL is for an external database. Remove the `mongo` object to use external databases.');
    }
    // MUP skips its MongoDB for such a config without an error; comet-deploy says so up front.
    const mongoServerNames = Object.keys(config.mongo.servers ?? {});
    if (mongoServerNames.length > 1) warn('mongo.servers', `has ${mongoServerNames.length} servers; MongoDB is set up on each of them, but the app uses only the first one ("${mongoServerNames[0]}")`);
    const problem = builtInMongoProblem(config);
    if (problem) warn('mongo', problem);
  }

  // proxy
  if (config.proxy) {
    issues.push(...joiIssues(proxySchema, config.proxy, 'proxy', (path) => path === 'proxy.domains'));
    // MUP's check: without load balancing, the proxy does not use the published port.
    const port = raw[appKey]?.env?.PORT;
    if (port && port !== 80 && !config.proxy.loadBalancing) warn('proxy', 'app.env.PORT is ignored when using the reverse proxy');
  }

  if (config.privateDockerRegistry) {
    issues.push(...joiIssues(registrySchema, config.privateDockerRegistry, 'privateDockerRegistry', (path) => path === 'privateDockerRegistry.host'));
    // Only one of them would log in with an empty value (in MUP's setup too).
    const { username, password } = config.privateDockerRegistry;
    if (!username !== !password) err('privateDockerRegistry', 'username and password go together: set both, or neither and log in to the registry yourself.');
  }
  // The registry decides the transfer: with it every image goes through the registry, and the
  // `registry` transfer has nothing to push to without it (registry design §4.2).
  const transfer = raw.cometDeploy?.transfer;
  if (config.privateDockerRegistry && (transfer === 'tunnel' || transfer === 'stream')) {
    err('cometDeploy.transfer', `"${transfer}" cannot be used with privateDockerRegistry: with a private registry the image goes through the registry. Remove cometDeploy.transfer or set it to "registry".`);
  }
  if (!config.privateDockerRegistry && transfer === 'registry') {
    err('cometDeploy.transfer', '"registry" needs a privateDockerRegistry section (host, imagePrefix, username, password).');
  }

  if (config.swarm?.enabled) err('swarm.enabled', 'Docker Swarm is not supported by comet-deploy');

  // From `raw`, where the user's hook names are.
  issues.push(...hookIssues(raw.hooks));

  if (Array.isArray(config.plugins) && config.plugins.length > 0) {
    warn('plugins', 'MUP plugins are not supported by comet-deploy and will be ignored');
  }

  // Checked on the raw value so messages refer to what the user wrote, not the merged defaults.
  // Unknown keys are warnings, as everywhere else; invalid values are errors.
  if (raw.cometDeploy !== undefined) {
    issues.push(...joiIssues(cometSchema, raw.cometDeploy, 'cometDeploy', (_p, type) => type !== 'object.unknown'));
  }

  return issues;
}
