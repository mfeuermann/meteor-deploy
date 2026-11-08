/** Raw object exported by mup.js / mup.json, before normalization. */
export type RawConfig = Record<string, any>;

export type EnvValue = string | number | boolean;

export interface ServerConfig {
  host: string;
  username: string;
  pem?: string;
  password?: string;
  opts?: { port?: number; [k: string]: unknown };
  privateIp?: string;
}

export interface AppServerRef {
  env?: Record<string, EnvValue>;
  bind?: string;
  settings?: string;
}

export interface DockerOptions {
  image: string;
  imagePort: number;
  args?: string[];
  bind?: string;
  prepareBundle?: boolean;
  prepareBundleLocally?: boolean;
  buildInstructions?: string[];
  stopAppDuringPrepareBundle?: boolean;
  useBuildKit?: boolean;
  networks?: string[];
  imageFrontendServer?: string;
}

export interface BuildOptions {
  serverOnly?: boolean;
  debug?: boolean;
  buildLocation: string;
  cleanBuildLocation?: boolean;
  mobileSettings?: Record<string, unknown>;
  server?: string;
  allowIncompatibleUpdates?: boolean;
  allowIncompatibleUpdate?: boolean;
  executable?: string;
  cleanAfterBuild?: boolean;
}

export interface AppConfig {
  name: string;
  path: string;
  type: string;
  servers: Record<string, AppServerRef>;
  env: Record<string, EnvValue>;
  docker: DockerOptions;
  buildOptions: BuildOptions;
  deployCheckWaitTime?: number;
  deployCheckPort?: number;
  enableUploadProgressBar?: boolean;
  log?: { driver?: string; opts?: Record<string, unknown> };
  volumes?: Record<string, string>;
  ssl?: unknown;
  nginx?: unknown;
  port?: number;
  [k: string]: unknown;
}

export type Strategy = 'canary' | 'rolling' | 'parallel';
export type Platform = 'linux/amd64' | 'linux/arm64';

export interface CometOptions {
  strategy: Strategy;
  transfer: 'auto' | 'tunnel' | 'registry' | 'stream';
  platform: 'auto' | Platform;
  keepVersions: number;
  zeroDowntime: boolean;
  healthCheck: { path: string; maxStatus: number };
  lock: boolean;
}

export interface RegistryConfig {
  host: string;
  imagePrefix?: string;
  username?: string;
  password?: string;
}

export interface NormalizedConfig {
  servers: Record<string, ServerConfig>;
  app: AppConfig;
  meteor?: unknown;
  mongo?: Record<string, any>;
  proxy?: Record<string, any>;
  privateDockerRegistry?: RegistryConfig;
  hooks?: Record<string, unknown>;
  plugins?: string[];
  swarm?: { enabled: boolean; [k: string]: unknown };
  cometDeploy: CometOptions;
  [k: string]: unknown;
}
