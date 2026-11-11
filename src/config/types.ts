/**
 * Types for the deploy config. Everything except `cometDeploy` mirrors the shape of a
 * Meteor Up (MUP) 1.5.11 config, so one `mup.js` / `mup.json` works with both tools. The
 * normalized shape is what `normalizeConfig` returns: MUP's defaults are filled in and a
 * top-level `meteor` section has been copied to `app`. See docs/configuration.md for the
 * user-facing reference of every option.
 */

/** Raw object exported by mup.js / mup.json, before normalization. */
export type RawConfig = Record<string, any>;

/** An env value as MUP accepts it. Written into `env.list` as `KEY=value`, unquoted. */
export type EnvValue = string | number | boolean;

/** One SSH target from the top-level `servers` section (MUP). */
export interface ServerConfig {
  /** Host name or IP address. */
  host: string;
  /** SSH user: `root`, or a user with passwordless sudo (every remote command uses sudo). */
  username: string;
  /**
   * Path to the private key (a `.pub` path is rejected). Relative to the current directory
   * like MUP; comet-deploy falls back to the config directory when the file is not there.
   */
  pem?: string;
  /** SSH password, used when there is no `pem`. */
  password?: string;
  /**
   * Passed to the ssh2 client as is (on top of the connection defaults). MUP's schema only
   * knows `port`; other ssh2 keys such as `passphrase` work but produce a validation warning.
   */
  opts?: { port?: number; [k: string]: unknown };
  /** Only used by MUP's proxy load balancing, which comet-deploy does not run yet. */
  privateIp?: string;
}

/** Per-server values under `app.servers.<name>` (MUP). */
export interface AppServerRef {
  /**
   * Merged over `app.env` for this server. `PORT` here sets the published host port on this
   * server and is not written into `env.list` (MUP behavior).
   */
  env?: Record<string, EnvValue>;
  /** Host address to publish the port on for this server; overrides `docker.bind`. */
  bind?: string;
  /** Path to a settings file whose JSON replaces `METEOR_SETTINGS` on this server. */
  settings?: string;
}

/**
 * `app.docker` (MUP). comet-deploy always builds the app image locally with BuildKit, so the
 * options that choose where and how MUP builds (`prepareBundleLocally`, `useBuildKit`,
 * `stopAppDuringPrepareBundle`) are accepted but have no effect.
 */
export interface DockerOptions {
  /** Base image. Defaults to MUP's `kadirahq/meteord`, which comet-deploy cannot build on yet. */
  image: string;
  /** Port the app listens on inside the container (default 3000, from MUP). */
  imagePort: number;
  /** Extra `docker run` arguments, inserted unquoted; one string may hold several flags. */
  args?: string[];
  /** Host address the port is published on (default `0.0.0.0` at render time, as in MUP). */
  bind?: string;
  /**
   * Whether the base image can build an app image. When unset, MUP's rule applies: true
   * for `zodern/meteor*` and `abernix/meteord*` images.
   */
  prepareBundle?: boolean;
  /** Ignored with a warning: comet-deploy always builds locally. */
  prepareBundleLocally?: boolean;
  /** Dockerfile lines inserted right after `FROM`. */
  buildInstructions?: string[];
  /** Ignored: there is no build on the server, so the app is never stopped for one. */
  stopAppDuringPrepareBundle?: boolean;
  /** Ignored with a warning: comet-deploy always uses BuildKit. */
  useBuildKit?: boolean;
  /** Docker networks the container is connected to after it starts. */
  networks?: string[];
  /** Deprecated in MUP 1.4; rejected by validation. */
  imageFrontendServer?: string;
}

/** `app.buildOptions`: options for the local `meteor build` (MUP). */
export interface BuildOptions {
  serverOnly?: boolean;
  debug?: boolean;
  /** Output directory of `meteor build`. Normalization fills in MUP's stable temp path. */
  buildLocation: string;
  /** Delete `buildLocation` before each build. Forced to true when `buildLocation` is defaulted. */
  cleanBuildLocation?: boolean;
  mobileSettings?: Record<string, unknown>;
  /** URL passed as `meteor build --server`. */
  server?: string;
  /** The key MUP's schema documents. MUP's build code never reads it; comet-deploy does. */
  allowIncompatibleUpdates?: boolean;
  /**
   * The key MUP's build code actually reads (not in MUP's schema, so it produces an
   * "unknown property" warning). comet-deploy accepts both spellings.
   */
  allowIncompatibleUpdate?: boolean;
  /** The Meteor command, default `meteor`. */
  executable?: string;
  /** Validated but unused, in MUP and here. */
  cleanAfterBuild?: boolean;
}

/** The `app` section (or the older `meteor` section, copied to `app` by normalization). */
export interface AppConfig {
  /** App name (no spaces). Names the container, `/opt/<name>` and the image `mup-<lowercased>`. */
  name: string;
  /** Path to the Meteor app, relative to the base path. */
  path: string;
  /** Set to `meteor` by normalization when missing. Only `meteor` apps are deployed. */
  type: string;
  /** The servers to deploy to. Key order is the rollout order (the first one is the canary). */
  servers: Record<string, AppServerRef>;
  /** Container environment. `ROOT_URL` is required; `PORT` is the published host port. */
  env: Record<string, EnvValue>;
  docker: DockerOptions;
  buildOptions: BuildOptions;
  /** Health check timeout in seconds (MUP option, default 60). */
  deployCheckWaitTime?: number;
  /** Container port the health check calls. MUP 1.5.11 ignores it; comet-deploy uses it. */
  deployCheckPort?: number;
  /** Ignored: comet-deploy does not upload a bundle. */
  enableUploadProgressBar?: boolean;
  /** Docker logging (`--log-driver`, `--log-opt`); MUP's default is applied in start.sh. */
  log?: { driver?: string; opts?: Record<string, unknown> };
  /** Bind mounts, host path to container path. */
  volumes?: Record<string, string>;
  /** Deprecated MUP option; rejected by validation. */
  ssl?: unknown;
  /** Deprecated MUP option; rejected by validation. */
  nginx?: unknown;
  /** Validated but unused, in MUP and here. */
  port?: number;
  [k: string]: unknown;
}

/**
 * Rollout strategy (comet-deploy addition). `canary`: the first server alone, then the rest
 * in parallel if it is healthy. `rolling`: one server at a time, stopping at the first
 * unhealthy one. `parallel`: all servers at once.
 */
export type Strategy = 'canary' | 'rolling' | 'parallel';
/** Docker platform of an app image; one image is built per platform among the targets. */
export type Platform = 'linux/amd64' | 'linux/arm64';

/**
 * The `cometDeploy` section: options MUP does not have. They live in their own top-level
 * section so they never change the meaning of a MUP option. MUP reports the unknown key but
 * keeps working, so the same config stays usable with both tools. Defaults are in
 * `DEFAULT_COMET_OPTIONS` (normalize.ts).
 */
export interface CometOptions {
  strategy: Strategy;
  /**
   * How the image reaches the servers. `auto` and `tunnel` both pull from a local registry
   * through an SSH reverse tunnel; `registry` and `stream` are planned for phase 2 and stop
   * the deploy.
   */
  transfer: 'auto' | 'tunnel' | 'registry' | 'stream';
  /** `auto` maps each server's `uname -m`; a fixed value is used for all servers. */
  platform: 'auto' | Platform;
  /** Version tags kept on each server for `rollback`. */
  keepVersions: number;
  /** Reserved for zero-downtime deploys behind the proxy (phase 2); no effect yet. */
  zeroDowntime: boolean;
  /** HTTP check after each start: healthy when `GET <path>` answers with status <= `maxStatus`. */
  healthCheck: { path: string; maxStatus: number };
  /** Take a lock on every target server before changing anything. */
  lock: boolean;
}

/** `privateDockerRegistry` (MUP). Validated and normalized, but not supported yet (phase 2). */
export interface RegistryConfig {
  host: string;
  /** Image name becomes `<imagePrefix>/mup-<lowercase app name>`. */
  imagePrefix?: string;
  username?: string;
  password?: string;
}

/**
 * The config after `normalizeConfig`: MUP's defaults filled in, `app` always present when the
 * user wrote `app` or `meteor`, and `cometDeploy` complete. `mongo`, `proxy`, `hooks` and
 * `swarm` are kept in MUP's shape so `validate --show` matches MUP, even where comet-deploy
 * does not act on them yet.
 */
export interface NormalizedConfig {
  servers: Record<string, ServerConfig>;
  app: AppConfig;
  /** The user's original `meteor` section, kept like MUP does (only scrubbing removes it). */
  meteor?: unknown;
  mongo?: Record<string, any>;
  proxy?: Record<string, any>;
  privateDockerRegistry?: RegistryConfig;
  hooks?: Record<string, unknown>;
  /** MUP plugins; ignored with a warning. */
  plugins?: string[];
  /** Docker Swarm; `enabled: true` is rejected. */
  swarm?: { enabled: boolean; [k: string]: unknown };
  cometDeploy: CometOptions;
  [k: string]: unknown;
}
