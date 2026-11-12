/**
 * Joi schemas for the config. Everything except `cometSchema` is ported from MUP 1.5.11
 * (lib/validate/servers.js and lib/plugins/{meteor,mongo,proxy,docker}/validate.js) so the
 * same config produces the same problems with the same paths. Unknown keys are reported, as
 * in MUP; validate.ts decides which problems are errors and which are warnings.
 */
import Joi from 'joi';

/** The types MUP allows for an env value. */
const envValue = [Joi.string(), Joi.number(), Joi.bool()];

/**
 * The top-level `servers` section. `opts` only knows `port`, like MUP: the other ssh2 options
 * people put there still work (the whole object goes to ssh2) but are reported as unknown.
 */
export const serversSchema = Joi.object().pattern(
  /.*/,
  Joi.object({
    host: Joi.string().trim().required(),
    username: Joi.string().required(),
    pem: Joi.string().trim(),
    password: Joi.string(),
    // MUP's schema knows only `port`, but every ssh2 option in `opts` is passed on to the
    // connection (also by MUP's nodemiral), e.g. `passphrase`: allowed, not an "unknown key".
    opts: Joi.object({ port: Joi.number() }).unknown(true),
    privateIp: Joi.string(),
  }),
);

/**
 * The `app` (or `meteor`) section, applied to the normalized app with `type` removed. It
 * still lists options comet-deploy ignores or rejects (`ssl`, `nginx`, `imageFrontendServer`,
 * `prepareBundleLocally`, ...), because they are valid MUP options; validate.ts reports them.
 */
export const appSchema = Joi.object({
  name: Joi.string().min(1).required(),
  path: Joi.string().min(1).required(),
  port: Joi.number(),
  type: Joi.string(),
  servers: Joi.object()
    .min(1)
    .required()
    .pattern(
      /[\s\S]*/,
      Joi.object({
        env: Joi.object().pattern(/[\s\S]*/, envValue),
        bind: Joi.string(),
        settings: Joi.string(),
      }),
    ),
  deployCheckWaitTime: Joi.number(),
  deployCheckPort: Joi.number(),
  enableUploadProgressBar: Joi.bool(),
  // Legacy alias of docker.image. Normalization moves it, so it is never seen here in practice.
  dockerImage: Joi.string(),
  docker: Joi.object({
    image: Joi.string().trim(),
    imagePort: Joi.number(),
    imageFrontendServer: Joi.string(),
    args: Joi.array().items(Joi.string()),
    bind: Joi.string().trim(),
    prepareBundle: Joi.bool(),
    prepareBundleLocally: Joi.bool(),
    buildInstructions: Joi.array().items(Joi.string()),
    stopAppDuringPrepareBundle: Joi.bool(),
    useBuildKit: Joi.bool(),
    networks: Joi.array().items(Joi.string()),
  }),
  buildOptions: Joi.object({
    serverOnly: Joi.bool(),
    debug: Joi.bool(),
    cleanAfterBuild: Joi.bool(),
    buildLocation: Joi.string(),
    mobileSettings: Joi.object(),
    server: Joi.string().uri(),
    allowIncompatibleUpdates: Joi.boolean(),
    executable: Joi.string(),
    cleanBuildLocation: Joi.bool(),
  }),
  env: Joi.object({
    ROOT_URL: Joi.string()
      .pattern(/^(http|https):\/\//i, 'valid url with "http://" or "https://"')
      .required(),
    MONGO_URL: Joi.string(),
  }).pattern(/[\s\S]*/, envValue),
  log: Joi.object({ driver: Joi.string(), opts: Joi.object() }),
  volumes: Joi.object(),
  nginx: Joi.object({ clientUploadLimit: Joi.string().trim() }),
  ssl: Joi.object(),
  // Old name of docker.imageFrontendServer: known, so it gets the error below, not "unknown key".
  dockerImageFrontendServer: Joi.string(),
});

/** MUP's built-in MongoDB section (run by src/mongo/). */
export const mongoSchema = Joi.object({
  oplog: Joi.bool(),
  port: Joi.number(),
  dbName: Joi.string(),
  dataPath: Joi.string(),
  version: Joi.string(),
  servers: Joi.object().required(),
});

/**
 * MUP's reverse proxy section (run by src/proxy/). The `ssl` rules
 * are MUP's: `crt` and `key` go together, Let's Encrypt excludes custom certificates, and at
 * least one of `letsEncryptEmail`, `crt` or `forceSSL` must be set.
 */
export const proxySchema = Joi.object({
  ssl: Joi.object({
    letsEncryptEmail: Joi.string().trim(),
    crt: Joi.string().trim(),
    key: Joi.string().trim(),
    forceSSL: Joi.bool(),
    upload: Joi.bool(),
  })
    .and('crt', 'key')
    .without('letsEncryptEmail', ['crt', 'key'])
    .or('letsEncryptEmail', 'crt', 'forceSSL'),
  domains: Joi.string().required(),
  nginxServerConfig: Joi.string(),
  nginxLocationConfig: Joi.string(),
  clientUploadLimit: Joi.string(),
  servers: Joi.object(),
  loadBalancing: Joi.bool(),
  stickySessions: Joi.bool(),
  shared: Joi.object({
    clientUploadLimit: Joi.alternatives().try(Joi.number(), Joi.string()),
    httpPort: Joi.number(),
    httpsPort: Joi.number(),
    nginxConfig: Joi.string(),
    nginxTemplate: Joi.string(),
    templatePath: Joi.string(),
    env: Joi.object().pattern(/[\s\S]*/, envValue),
    envLetsEncrypt: Joi.object({
      ACME_CA_URI: Joi.string().pattern(/^(http|https):\/\//i),
      DEBUG: Joi.boolean(),
      NGINX_PROXY_CONTAINER: Joi.string(),
    }).pattern(/[\s\S]*/, envValue),
  }),
});

/** `privateDockerRegistry` (MUP's docker plugin). `host` is required by MUP's schema. */
export const registrySchema = Joi.object({
  host: Joi.string().required(),
  imagePrefix: Joi.string(),
  username: Joi.string(),
  password: Joi.string(),
});

/**
 * The `cometDeploy` section (comet-deploy addition). Validated against the user's raw value,
 * not the normalized one, so messages refer to what the user wrote.
 */
export const cometSchema = Joi.object({
  strategy: Joi.string().valid('canary', 'rolling', 'parallel'),
  transfer: Joi.string().valid('auto', 'tunnel', 'registry', 'stream'),
  platform: Joi.string().valid('auto', 'linux/amd64', 'linux/arm64'),
  keepVersions: Joi.number().integer().min(1),
  zeroDowntime: Joi.bool(),
  healthCheck: Joi.object({
    path: Joi.string().pattern(/^\//, 'path starting with "/"'),
    maxStatus: Joi.number().integer().min(100).max(599),
  }),
  lock: Joi.bool(),
});

/**
 * Top-level keys that are not reported as unknown: MUP's own keys plus `cometDeploy`. MUP
 * itself reports `cometDeploy` as unknown but does not stop on it.
 */
export const KNOWN_TOP_LEVEL_KEYS = new Set([
  'servers',
  'app',
  'meteor',
  'mongo',
  'proxy',
  'privateDockerRegistry',
  'hooks',
  'plugins',
  'swarm',
  'cometDeploy',
]);
