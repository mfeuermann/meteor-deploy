/**
 * The context every CLI command receives. createContext loads, normalizes and validates the
 * config, registers its secrets with the reporter, checks `--servers`, and wires up the SSH
 * pool and the command runner. Settings are loaded lazily, only by commands that need them.
 */
import { loadConfig, loadSettings } from '../config/load.js';
import { normalizeConfig } from '../config/normalize.js';
import { parseServerFilter, selectServers } from '../config/servers.js';
import type { NormalizedConfig, RawConfig } from '../config/types.js';
import { hasFatal, validateConfig, type Issue } from '../config/validate.js';
import { createReporter, type Reporter } from '../output/reporter.js';
import { collectSecrets } from '../output/secrets.js';
import { loadServerSettings } from '../remote/app-files.js';
import type { SshConnection } from '../ssh/connection.js';
import { SshPool } from '../ssh/pool.js';
import { CometError } from './errors.js';
import { CommandRunner } from './runner.js';

/** The global CLI options, named like MUP's. */
export interface GlobalArgs {
  /** `--config`: path to mup.js / mup.json, relative to cwd. */
  config?: string;
  /** `--settings`: path to the Meteor settings file, relative to cwd. */
  settings?: string;
  /** `--servers`: server names separated by spaces or commas. */
  servers?: string;
  verbose?: boolean;
  'show-hook-names'?: boolean;
}

/** What commands need from the SSH layer (`SshPool`; tests pass stubs). */
export interface SshPoolLike {
  get(name: string): Promise<SshConnection>;
  closeAll(): Promise<void>;
}

/** Creates the SSH pool for a config; replaced in tests to avoid real connections. */
export type SshPoolFactory = (c: NormalizedConfig, cwd: string, basePath: string) => SshPoolLike;

/** Context for commands that do not need a config (init, validate). */
export interface BaseContext {
  cwd: string;
  verbose: boolean;
  argv: Record<string, unknown>;
  reporter: Reporter;
  /** Raw stdout line (not masked), for machine-readable output such as `validate --show`. */
  print(text: string): void;
}

/** Context for commands that need a valid config. Built by createContext. */
export interface CommandContext extends BaseContext {
  basePath: string;
  configPath: string;
  raw: RawConfig;
  config: NormalizedConfig;
  /** Validation warnings (already printed); a context is never created when there are errors. */
  issues: Issue[];
  /** Names from `--servers` (all known), or null when the flag was not given. */
  serverFilter: string[] | null;
  /** SSH pool that connects on first use. The CLI closes it after the command. */
  ssh: SshPoolLike;
  runner: CommandRunner;
  /**
   * The Meteor settings. Loaded and cached on the first call; always returns the same
   * (mutable) object. Throws CometError when the settings file or a per-server settings
   * file is missing or invalid.
   */
  getSettings(): unknown;
  /**
   * Loads the settings only so that their values are masked in the output, for the commands
   * that print app output (logs, the log tail of a failed health check) without using the
   * settings. Never throws: a missing or invalid file is reported by `getSettings` where the
   * settings are needed.
   */
  maskSettings(): void;
  /** Keys of `app.servers` selected by `--servers`, in config order. */
  appServers(): string[];
}

/** Injection points for tests; production code uses the defaults. */
export interface ContextDeps {
  cwd?: string;
  reporter?: Reporter;
  print?: (text: string) => void;
  sshPoolFactory?: SshPoolFactory;
}

const defaultSshPoolFactory: SshPoolFactory = (c, cwd, basePath) => new SshPool(c.servers, { cwd, basePath });

/** `<path> <message>`, the format MUP prints validation problems in. */
export function formatIssue(i: Issue): string {
  return `${i.path} ${i.message}`;
}

/** A loaded config with its normalized form and validation issues. */
export interface LoadedProject {
  configPath: string;
  basePath: string;
  raw: RawConfig;
  config: NormalizedConfig;
  issues: Issue[];
}

/**
 * Load → normalize → validate, without failing on issues (the `validate` command reports
 * them itself). Throws CometError only when the config file cannot be found or loaded.
 */
export function loadProject(argv: GlobalArgs, cwd: string): LoadedProject {
  const { configPath, basePath, raw } = loadConfig(cwd, argv.config);
  const config = normalizeConfig(raw, { basePath });
  return { configPath, basePath, raw, config, issues: validateConfig(config, raw) };
}

/** Creates the context for commands that run without a config. */
export function createBaseContext(argv: GlobalArgs & Record<string, unknown>, deps: ContextDeps = {}): BaseContext {
  const verbose = !!argv.verbose;
  return {
    cwd: deps.cwd ?? process.cwd(),
    verbose,
    argv,
    reporter: deps.reporter ?? createReporter({ verbose, tty: !!process.stdout.isTTY }),
    print: deps.print ?? ((t) => void process.stdout.write(t + '\n')),
  };
}

/**
 * Creates the context for commands that need a config. Prints the validation warnings.
 * Does not open SSH connections or read the settings yet.
 *
 * @throws CometError when the config cannot be loaded, has validation errors, or `--servers`
 *   names an unknown server.
 */
export async function createContext(argv: GlobalArgs & Record<string, unknown>, deps: ContextDeps = {}): Promise<CommandContext> {
  const base = createBaseContext(argv, deps);
  const { reporter, cwd } = base;
  const project = loadProject(argv, cwd);
  const { config, issues, basePath } = project;
  // Before printing anything: Joi messages can quote config values (e.g. a ROOT_URL that
  // fails the pattern), and the error thrown below is masked with the same list.
  reporter.addSecrets(collectSecrets(config));

  for (const i of issues) if (i.severity === 'warning') reporter.warn(formatIssue(i));
  if (hasFatal(issues)) {
    const list = issues.filter((i) => i.severity === 'error').map((i) => `  - ${formatIssue(i)}`);
    throw new CometError(`Invalid config ${project.configPath}:\n${list.join('\n')}`, {
      hint: 'Run "comet-deploy validate" to see all problems.',
    });
  }

  const serverFilter = parseServerFilter(argv.servers);
  // Only to fail early on unknown names. Each command applies the filter to its own server
  // list (app servers for deploys, all servers for setup and docker).
  if (serverFilter) selectServers(Object.keys(config.servers), serverFilter);

  let settings: unknown;
  let settingsLoaded = false;
  const appServers = () => {
    const appKeys = Object.keys(config.app.servers ?? {});
    return serverFilter ? appKeys.filter((n) => serverFilter.includes(n)) : appKeys;
  };

  const getSettings = (): unknown => {
    if (!settingsLoaded) {
      const loaded = loadSettings({ cwd, basePath, settingsFlag: argv.settings }).settings;
      // Per-server settings files are secret too. Loading them here also fails early when one
      // is missing, before anything changes on the servers. Only the selected servers' files:
      // the others are never rendered or printed, and may not exist on this machine.
      const perServer = appServers().map((s) => loadServerSettings(config, s, { cwd, basePath }));
      reporter.addSecrets(collectSecrets(config, loaded, perServer));
      // Cached only when everything loaded, so a failure is reported again on the next call.
      settings = loaded;
      settingsLoaded = true;
    }
    return settings;
  };
  const maskSettings = () => {
    try {
      getSettings();
    } catch {
      // Not needed by the command; where the settings are used, getSettings reports it.
    }
  };

  return {
    ...base,
    ...project,
    serverFilter,
    ssh: (deps.sshPoolFactory ?? defaultSshPoolFactory)(config, cwd, basePath),
    runner: new CommandRunner((config.hooks as Record<string, unknown> | undefined) ?? {}),
    getSettings,
    maskSettings,
    appServers,
  };
}
