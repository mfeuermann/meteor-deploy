/**
 * The `api` argument of method hooks: the part of MUP 1.5.11's `PluginAPI` that works without
 * nodemiral sessions (hooks design §4.6). It wraps the command context, so a hook that changes
 * the config or the settings changes what the later steps use.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expandTilde, loadSettingsFile } from '../config/load.js';
import { resolveAppPath } from '../config/normalize.js';
import { scrubConfig } from '../config/scrub.js';
import type { NormalizedConfig, ServerConfig } from '../config/types.js';
import { validateConfig } from '../config/validate.js';
import { formatIssue, type CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { logsPassthrough } from '../cli/commands/lifecycle.js';
import { SshConnection } from '../ssh/connection.js';

/** What `api.runSSHCommand` resolves to, as in MUP. */
export interface SshCommandResult {
  code: number;
  output: string;
  host: string;
}

/** The members of MUP's PluginAPI that comet-deploy cannot offer: they take or return nodemiral sessions or swarm data. */
const UNSUPPORTED = ['getSessions', 'getSessionsForServers', 'getManagerSession', 'runTaskList', 'getDockerLogs', 'getServerInfo', 'serverInfoStale', 'swarmInfo', 'dockerServiceInfo', 'forwardPort'] as const;

const unsupported = (name: string) =>
  new CometError(`api.${name}() is not supported by comet-deploy (it needs MUP's nodemiral sessions). Use api.runSSHCommand(server, command) or a remoteCommand hook.`);

/** An object whose every member is unsupported (`api.tasks`, `api.statusHelpers`). */
const unsupportedGroup = (group: string): object =>
  new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        throw unsupported(`${group}.${prop}`);
      },
    },
  );

/** The api object of method hooks. Members are typed loosely, as hooks are plain JavaScript. */
export type PluginApi = Record<string, any>;

/**
 * Creates the api object for one command run. `runCommand` runs a comet-deploy step by its MUP
 * key (src/hooks/commands.ts).
 */
export function createPluginApi(ctx: CommandContext, runCommand: (key: string) => Promise<void>): PluginApi {
  const getArgs = () => logsPassthrough(ctx.argv, []);
  const api: PluginApi = {
    getArgs,
    getBasePath: () => ctx.basePath,
    getVerbose: () => ctx.verbose,
    getOptions: () => ctx.argv,
    getConfig: () => ctx.config,
    setConfig: (c: NormalizedConfig) => ctx.setConfig(c),
    validateConfig: () => validateConfig(ctx.config, ctx.raw).map(formatIssue),
    scrubConfig: () => scrubConfig(ctx.config),
    getSettings: () => ctx.getSettings(),
    getSettingsFromPath: (p: string) => loadSettingsFile(resolve(ctx.cwd, expandTilde(p))),
    runCommand: (key: string) => runCommand(key),
    runSSHCommand: (server: ServerConfig, command: string) => runSshCommand(ctx, server, command),
    resolvePath: (...paths: string[]) => resolve(...paths.map(expandTilde)),
    hasMeteorPackage: (name: string) => hasMeteorPackage(ctx, name),
    swarmEnabled: () => false,
    tasks: unsupportedGroup('tasks'),
    statusHelpers: unsupportedGroup('statusHelpers'),
  };
  for (const name of UNSUPPORTED) {
    api[name] = () => {
      throw unsupported(name);
    };
  }
  Object.defineProperties(api, {
    base: { get: () => ctx.basePath, enumerable: true },
    args: { get: getArgs, enumerable: true },
    config: { get: () => ctx.config, enumerable: true },
    settings: { get: () => ctx.getSettings(), set: (v: unknown) => ctx.setSettings(v), enumerable: true },
    configPath: { get: () => ctx.configPath, enumerable: true },
    settingsPath: { get: () => ctx.argv.settings, enumerable: true },
    verbose: { get: () => ctx.verbose, enumerable: true },
    program: { get: () => ctx.argv, enumerable: true },
    commandHistory: { get: () => ctx.runner.history.map((name) => ({ name })), enumerable: true },
  });
  return api;
}

/**
 * MUP's `runSSHCommand`: runs `command` on `server` (an object of `config.servers`, found by
 * identity or host, else connected to on its own) and resolves with the exit code and the
 * combined output.
 */
async function runSshCommand(ctx: CommandContext, server: ServerConfig, command: string): Promise<SshCommandResult> {
  const name = Object.entries(ctx.config.servers ?? {}).find(([, s]) => s === server || s.host === server?.host)?.[0];
  const own = name ? null : await SshConnection.connect('hook', server, { cwd: ctx.cwd, basePath: ctx.basePath });
  try {
    const conn = own ?? (await ctx.ssh.get(name!));
    let output = '';
    const collect = (chunk: string) => void (output += chunk);
    const r = await conn.exec(command, { onStdout: collect, onStderr: collect });
    return { code: r.code, output, host: server.host };
  } finally {
    await own?.close();
  }
}

/** MUP's `hasMeteorPackage`, reading the app's `.meteor/versions` (MUP reads `meteor.path`, which most configs do not have). */
function hasMeteorPackage(ctx: CommandContext, name: string): boolean {
  const file = join(resolveAppPath(ctx.config, ctx.basePath), '.meteor', 'versions');
  try {
    return new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@`, 'm').test(readFileSync(file, 'utf8'));
  } catch {
    ctx.reporter.info(`Unable to load file ${file}`);
    return false;
  }
}
