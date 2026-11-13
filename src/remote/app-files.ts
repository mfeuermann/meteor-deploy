/**
 * The app files MUP 1.5.11 renders on each server: `/opt/<app>/config/start.sh` (the container
 * launcher) and `config/env.list` (its `--env-file`) from `meteor envconfig`, plus the
 * `meteor start/stop/setup/destroy` scripts. Variables are computed exactly like MUP's
 * `envconfig` / `createEnv` / `addStartAppTask` so the output is byte-identical and MUP and
 * comet-deploy can take turns on the same server. One deliberate difference: per-server values
 * never leak into other servers (MUP shares the merged vars object across hosts, so a server's
 * bind, PORT, env or settings reach every server rendered after it).
 */
import cloneDeep from 'lodash/cloneDeep.js';
import merge from 'lodash/merge.js';
import { loadSettingsFile, resolveUserPath } from '../config/load.js';
import type { NormalizedConfig } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { renderTemplate } from './render.js';

// MUP's original templates, rendered as they are: byte-identical output depends on it.
const START_SH = 'mup/meteor/templates/start.sh';
const ENV_LIST = 'mup/meteor/templates/env.list';

/** The `app.servers` entry of `serverName`; throws when it is not one of the app servers. */
function serverRef(c: NormalizedConfig, serverName: string) {
  const ref = c.app.servers?.[serverName];
  if (!ref) throw new CometError(`Server "${serverName}" is not listed in app.servers`);
  return ref;
}

/**
 * Renders `/opt/<app>/config/start.sh` for one server, exactly as MUP's envconfig does without
 * a private registry (also when the config has one, see `imagePrefix` below). The script
 * replaces the app container with one from `mup-<lc>:latest`, and falls back to `docker.image`
 * with the bundle mounted (bundle mode) when that tag is missing, which is why comet-deploy
 * always keeps `:latest` on the active version. The server's `bind` and `env.PORT` override
 * the app-wide values.
 */
export async function renderStartSh(c: NormalizedConfig, serverName: string): Promise<string> {
  const app: any = cloneDeep(c.app);
  // Runtime defaults that MUP applies in envconfig, not when it normalizes the config.
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
    // Always MUP's start.sh without a registry (registry design §4.1): with one, MUP's pulls
    // `<prefix>/mup-<app>:latest` on every start, so the registry would decide which version a
    // server runs, not the activation (no canary, revert or rollback per server). The registry
    // only carries the image; the server keeps it as `mup-<app>:<version>`.
    imagePrefix: 'mup-',
    appName: app.name,
    // The host port start.sh publishes; inside the container the app listens on
    // docker.imagePort (see createEnv).
    port: app.env.PORT || 80,
    bind: bindAddress,
    sslConfig: app.ssl,
    logConfig: app.log,
    volumes: app.volumes,
    docker: app.docker,
    proxyConfig: cloneDeep(c.proxy),
    nginxClientUploadLimit: app.nginx.clientUploadLimit || '10M',
    // The template reads the variable, so it must exist (MUP passes `undefined` without a registry).
    privateRegistry: undefined,
  };
  // `vars` is built fresh on every call, so merging this server's values into it cannot reach
  // another server (unlike in MUP, see the header).
  return renderTemplate(START_SH, merge(vars, hostVars));
}

/**
 * MUP `createEnv`: the container environment before per-server overrides: app.env +
 * METEOR_SETTINGS (the settings as JSON) + PORT = docker.imagePort. An `app.env.PORT` is the
 * published host port (start.sh), so the container gets the image port instead.
 */
function createEnv(c: NormalizedConfig, settings: unknown): Record<string, unknown> {
  const env: Record<string, unknown> = cloneDeep(c.app.env);
  env.METEOR_SETTINGS = JSON.stringify(settings);
  env.PORT = c.app.docker.imagePort;
  return env;
}

/**
 * The settings file of one server (`app.servers.<name>.settings`, MUP's
 * per-server METEOR_SETTINGS), or undefined when that server has none.
 * Like in MUP the path is relative to the process cwd, not to the config file (see
 * `resolveUserPath` for the fallback). Reads the local file and throws CometError when it is
 * missing or not valid JSON.
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

/**
 * Throws CometError, naming the variable, when a line of the rendered env.list is too long for
 * Docker. The line is measured as rendered, including the indentation of MUP's format, because
 * Docker's scanner counts those bytes too.
 */
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

/**
 * env.list of one server, exactly as MUP renders it: createEnv, then the server's `env` and
 * its own settings file merged on top. Values are written raw (no quoting or escaping), as in
 * MUP; Docker takes everything after the first `=` literally. Throws CometError when the
 * per-server settings cannot be loaded or Docker could not read a line.
 */
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
    // lodash `merge` skips `undefined` source values, so PORT stays docker.imagePort.
    hostVars = { env: { ...ref.env, PORT: undefined } };
  }
  const perServerSettings = loadServerSettings(c, serverName, o);
  if (perServerSettings !== undefined) {
    const perServer = JSON.stringify(perServerSettings);
    if (hostVars) hostVars.env.METEOR_SETTINGS = perServer;
    else hostVars = { env: { METEOR_SETTINGS: perServer } };
  }
  const vars = { env: createEnv(c, settings), appName: c.app.name };
  const out = await renderTemplate(ENV_LIST, merge(vars, hostVars));
  assertEnvLinesFit(out, serverName);
  return out;
}

/**
 * MUP's `meteor-start.sh`: prepares `/opt/<app>/current` for image or bundle mode, then runs
 * `config/start.sh` as it is on the server. `removeImage` first deletes `:latest` so start.sh
 * falls back to the uploaded bundle (base images that cannot prepare a bundle).
 */
export async function renderMeteorStart(c: NormalizedConfig, o: { removeImage?: boolean } = {}): Promise<string> {
  return renderTemplate('mup/meteor/meteor-start.sh', {
    appName: c.app.name,
    removeImage: o.removeImage ?? false,
    privateRegistry: c.privateDockerRegistry,
  });
}

/** MUP's `meteor-stop.sh`: removes the app container and its legacy proxy/frontend containers. */
export async function renderMeteorStop(c: NormalizedConfig): Promise<string> {
  return renderTemplate('mup/meteor/meteor-stop.sh', { appName: c.app.name });
}

/**
 * MUP's `meteor-setup.sh`: creates `/opt/<app>/config` and `/opt/<app>/tmp` and hands
 * `/opt/<app>` to the SSH user, so SFTP uploads, the lock and the history work without sudo.
 * (This MUP template calls the app name `name`, not `appName`.)
 */
export async function renderMeteorSetup(c: NormalizedConfig): Promise<string> {
  return renderTemplate('mup/meteor/meteor-setup.sh', { name: c.app.name });
}

/**
 * MUP's `meteor-destroy.sh`: removes `/opt/<app>` and the `:latest`, `:previous` and `:build`
 * images. The version tags MUP does not know about are removed by `destroy-extra.sh`.
 */
export async function renderMeteorDestroy(c: NormalizedConfig): Promise<string> {
  return renderTemplate('mup/meteor/meteor-destroy.sh', { name: c.app.name });
}
