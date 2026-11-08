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
  if (ref.settings) {
    const path = resolveUserPath(ref.settings, { cwd: o.cwd, basePath: o.basePath, base: 'cwd' });
    const perServer = JSON.stringify(loadSettingsFile(path));
    if (hostVars) hostVars.env.METEOR_SETTINGS = perServer;
    else hostVars = { env: { METEOR_SETTINGS: perServer } };
  }
  const vars = { env: createEnv(c, settings) || {}, appName: c.app.name };
  return renderTemplate(ENV_LIST, merge(vars, hostVars));
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
