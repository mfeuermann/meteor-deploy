import { loadConfig, loadSettings } from '../config/load.js';
import { normalizeConfig } from '../config/normalize.js';
import { parseServerFilter, selectServers } from '../config/servers.js';
import type { NormalizedConfig, RawConfig } from '../config/types.js';
import { hasFatal, validateConfig, type Issue } from '../config/validate.js';
import { createReporter, type Reporter } from '../output/reporter.js';
import { collectSecrets } from '../output/secrets.js';
import { CometError } from './errors.js';
import { CommandRunner } from './runner.js';

export interface GlobalArgs {
  config?: string;
  settings?: string;
  servers?: string;
  verbose?: boolean;
  'show-hook-names'?: boolean;
}

/** What the context needs from the SSH layer (implemented by `SshPool`, task 8). */
export interface SshPoolLike {
  get(name: string): Promise<any>;
  closeAll(): Promise<void>;
}

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

export interface CommandContext extends BaseContext {
  basePath: string;
  configPath: string;
  raw: RawConfig;
  config: NormalizedConfig;
  issues: Issue[];
  serverFilter: string[] | null;
  ssh: SshPoolLike;
  runner: CommandRunner;
  /** Lazily loaded and cached; always returns the same (mutable) object. */
  getSettings(): unknown;
  /** Keys of `app.servers` selected by `--servers`, in config order. */
  appServers(): string[];
}

export interface ContextDeps {
  cwd?: string;
  reporter?: Reporter;
  print?: (text: string) => void;
  sshPoolFactory?: SshPoolFactory;
}

let defaultSshPoolFactory: SshPoolFactory = () => ({
  async get() {
    throw new CometError('SSH is not available in this build.');
  },
  async closeAll() {},
});

/** Lets the SSH layer register the real pool without a circular import. */
export function setDefaultSshPoolFactory(f: SshPoolFactory): void {
  defaultSshPoolFactory = f;
}

export function formatIssue(i: Issue): string {
  return `${i.path} ${i.message}`;
}

export interface LoadedProject {
  configPath: string;
  basePath: string;
  raw: RawConfig;
  config: NormalizedConfig;
  issues: Issue[];
}

/** Load → normalize → validate, without failing on issues. */
export function loadProject(argv: GlobalArgs, cwd: string): LoadedProject {
  const { configPath, basePath, raw } = loadConfig(cwd, argv.config);
  const config = normalizeConfig(raw, { basePath });
  return { configPath, basePath, raw, config, issues: validateConfig(config, raw) };
}

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

export async function createContext(argv: GlobalArgs & Record<string, unknown>, deps: ContextDeps = {}): Promise<CommandContext> {
  const base = createBaseContext(argv, deps);
  const { reporter, cwd } = base;
  const project = loadProject(argv, cwd);
  const { config, issues, basePath } = project;
  reporter.addSecrets(collectSecrets(config));

  for (const i of issues) if (i.severity === 'warning') reporter.warn(formatIssue(i));
  if (hasFatal(issues)) {
    const list = issues.filter((i) => i.severity === 'error').map((i) => `  - ${formatIssue(i)}`);
    throw new CometError(`Invalid config ${project.configPath}:\n${list.join('\n')}`, {
      hint: 'Run "comet-deploy validate" to see all problems.',
    });
  }

  const serverFilter = parseServerFilter(argv.servers);
  if (serverFilter) selectServers(Object.keys(config.servers), serverFilter);

  let settings: unknown;
  let settingsLoaded = false;

  return {
    ...base,
    ...project,
    serverFilter,
    ssh: (deps.sshPoolFactory ?? defaultSshPoolFactory)(config, cwd, basePath),
    runner: new CommandRunner(),
    getSettings() {
      if (!settingsLoaded) {
        settings = loadSettings({ cwd, basePath, settingsFlag: argv.settings }).settings;
        settingsLoaded = true;
        reporter.addSecrets(collectSecrets(config, settings));
      }
      return settings;
    },
    appServers() {
      const appKeys = Object.keys(config.app.servers ?? {});
      return serverFilter ? appKeys.filter((n) => serverFilter.includes(n)) : appKeys;
    },
  };
}
