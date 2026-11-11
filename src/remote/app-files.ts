/**
 * Files MUP 1.5.11 renders for the app on each server (`meteor envconfig`,
 * `meteor start/stop/setup/destroy`). Variables are computed exactly like MUP's
 * `envconfig` / `createEnv` / `addStartAppTask` so the output is byte-identical,
 * except that per-server values never leak into other servers (MUP shares the
 * merged vars object across hosts).
 */
import cloneDeep from 'lodash/cloneDeep.js';
import merge from 'lodash/merge.js';
import { loadSettingsFile, resolveUserPath } from '../config/load.js';
import type { NormalizedConfig } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { renderTemplate } from './render.js';

const START_SH = 'mup/meteor/templates/start.sh';
const ENV_LIST = 'mup/meteor/templates/env.list';

function imagePrefix(c: NormalizedConfig): string {
  const prefix = c.privateDockerRegistry?.imagePrefix;
  return prefix ? `${prefix}/mup-` : 'mup-';
}

function serverRef(c: NormalizedConfig, serverName: string) {
  const ref = c.app.servers?.[serverName];
  if (!ref) throw new Error(`Server "${serverName}" is not listed in app.servers`);
  return ref;
}

export async function renderStartSh(c: NormalizedConfig, serverName: string): Promise<string> {
  const app: any = cloneDeep(c.app);
  app.log = app.log || { opts: { 'max-size': '100m', 'max-file': 10 } };
  app.nginx = app.nginx || {};
  const bindAddress = app.docker && app.docker.bind ? app.docker.bind : '0.0.0.0';
  if (app.dockerImageFrontendServer) app.docker.imageFrontendServer = app.dockerImageFrontendServer;
  if (!app.docker.imageFrontendServer) app.docker.imageFrontendServer = 'meteorhacks/mup-frontend-server';
  if (app.ssl) app.ssl.port = app.ssl.port || 443;

  const ref = serverRef(c, serverName);
  const hostVars: Record<string, unknown> = {};
  if (ref.bind) hostVars.bind = ref.bind;
  if (ref.env && ref.env.PORT) hostVars.port = ref.env.PORT;

  const vars = {
    imagePrefix: imagePrefix(c),
    appName: app.name,
    port: app.env.PORT || 80,
    bind: bindAddress,
    sslConfig: app.ssl,
    logConfig: app.log,
    volumes: app.volumes,
    docker: app.docker,
    proxyConfig: cloneDeep(c.proxy),
    nginxClientUploadLimit: app.nginx.clientUploadLimit || '10M',
    privateRegistry: cloneDeep(c.privateDockerRegistry),
  };
  return renderTemplate(START_SH, merge(vars, hostVars));
}

/** MUP `createEnv`: app.env + METEOR_SETTINGS + PORT = docker.imagePort. */
function createEnv(c: NormalizedConfig, settings: unknown): Record<string, unknown> {
  const env: Record<string, unknown> = cloneDeep(c.app.env);
  env.METEOR_SETTINGS = JSON.stringify(settings);
  env.PORT = c.app.docker.imagePort;
  return env;
}

/**
 * The settings file of one server (`app.servers.<name>.settings`, MUP's
 * per-server METEOR_SETTINGS), or undefined when that server has none.
 */
export function loadServerSettings(c: NormalizedConfig, serverName: string, o: { cwd: string; basePath: string }): unknown {
  const ref = serverRef(c, serverName);
  if (!ref.settings) return undefined;
  return loadSettingsFile(resolveUserPath(ref.settings, { cwd: o.cwd, basePath: o.basePath, base: 'cwd' }));
}

/**
 * Docker reads `--env-file` with a line scanner whose token limit is 64 KiB:
 * a longer line (in practice a huge METEOR_SETTINGS) makes `docker run` fail
 * with "bufio.Scanner: token too long", so the app would never start.
 */
const ENV_FILE_MAX_LINE_BYTES = 64 * 1024;

function assertEnvLinesFit(envList: string, serverName: string): void {
  for (const line of envList.split('\n')) {
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes < ENV_FILE_MAX_LINE_BYTES) continue;
    const key = line.trim().split('=')[0];
    throw new CometError(
      `The env.list for server "${serverName}" has a ${key} line of ${(bytes / 1024).toFixed(1)} KiB. ` +
        'Docker reads --env-file lines only up to 64 KiB, so the app could not start.',
      { hint: key === 'METEOR_SETTINGS' ? 'Make the settings smaller, e.g. move large data out of settings.json into the database or a file.' : `Shorten the value of ${key}.` },
    );
  }
}

/** env.list of one server, exactly as MUP renders it; throws when Docker could not read it. */
export async function renderEnvList(
  c: NormalizedConfig,
  settings: unknown,
  serverName: string,
  o: { cwd: string; basePath: string },
): Promise<string> {
  const ref = serverRef(c, serverName);
  let hostVars: { env: Record<string, unknown> } | undefined;
  if (ref.env) {
    // PORT of a server is its published host port (start.sh), not a container env var.
    hostVars = { env: { ...ref.env, PORT: undefined } };
  }
  const perServerSettings = loadServerSettings(c, serverName, o);
  if (perServerSettings !== undefined) {
    const perServer = JSON.stringify(perServerSettings);
    if (hostVars) hostVars.env.METEOR_SETTINGS = perServer;
    else hostVars = { env: { METEOR_SETTINGS: perServer } };
  }
  const vars = { env: createEnv(c, settings) || {}, appName: c.app.name };
  const out = await renderTemplate(ENV_LIST, merge(vars, hostVars));
  assertEnvLinesFit(out, serverName);
  return out;
}

export async function renderMeteorStart(c: NormalizedConfig, o: { removeImage?: boolean } = {}): Promise<string> {
  return renderTemplate('mup/meteor/meteor-start.sh', {
    appName: c.app.name,
    removeImage: o.removeImage ?? false,
    privateRegistry: c.privateDockerRegistry,
  });
}

export async function renderMeteorStop(c: NormalizedConfig): Promise<string> {
  return renderTemplate('mup/meteor/meteor-stop.sh', { appName: c.app.name });
}

export async function renderMeteorSetup(c: NormalizedConfig): Promise<string> {
  return renderTemplate('mup/meteor/meteor-setup.sh', { name: c.app.name });
}

export async function renderMeteorDestroy(c: NormalizedConfig): Promise<string> {
  return renderTemplate('mup/meteor/meteor-destroy.sh', { name: c.app.name });
}
