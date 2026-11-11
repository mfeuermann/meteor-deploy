/**
 * The comet-deploy CLI: builds the yargs command tree from the command modules in `./commands`,
 * creates the context each command runs with, and turns any error into a message and an exit
 * code. When this file runs as the `comet-deploy` bin script, it parses `process.argv` and sets
 * the process exit code; when tests import it, `main()` and `buildCli()` run in-process.
 */
import yargs, { type Argv } from 'yargs';
import { createBaseContext, createContext, type SshPoolFactory } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { TOOL_VERSION } from '../core/version.js';
import { createReporter, type Reporter } from '../output/reporter.js';
import { deployCommand, meteorBuildCommand, meteorDeployCommand, meteorPushCommand } from './commands/deploy.js';
import { meteorDestroyCommand } from './commands/destroy.js';
import { DOCKER_COMMANDS } from './commands/docker.js';
import { historyCommand } from './commands/history.js';
import { initCommand } from './commands/init.js';
import { isEntryPoint } from './entry.js';
import { LIFECYCLE_COMMANDS } from './commands/lifecycle.js';
import { PHASE2_COMMANDS } from './commands/phase2.js';
import { rollbackCommand } from './commands/rollback.js';
import { meteorSetupCommand, setupCommand } from './commands/setup.js';
import { meteorStatusCommand, statusCommand } from './commands/status.js';
import { unlockCommand } from './commands/unlock.js';
import { validateCommand } from './commands/validate.js';
import { registerCommands, type CommandModule } from './registry.js';

/** Where the CLI writes its output. Tests pass their own functions to capture it. */
export interface CliIO {
  /** Reporter output, `--help` and `--version` text. */
  stdout: (s: string) => void;
  /** Top-level errors, and the usage text yargs prints with a parse error. */
  stderr: (s: string) => void;
}

/** Replaceable dependencies of the CLI, for tests. */
export interface MainDeps {
  /** Directory to look for the config in (default: `process.cwd()`). */
  cwd?: string;
  /** Replaces the real SSH pool, e.g. with stubs that never open a connection. */
  sshPoolFactory?: SshPoolFactory;
}

const defaultIO: CliIO = {
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
};

/**
 * Every command the CLI knows. Top-level commands are listed in `--help` in this order (those
 * with `describe: false` are hidden); commands with a `group` become `meteor …` / `docker …`
 * subcommands.
 */
export const COMMANDS: CommandModule[] = [
  initCommand,
  validateCommand,
  setupCommand,
  deployCommand,
  meteorDeployCommand,
  meteorPushCommand,
  meteorBuildCommand,
  ...LIFECYCLE_COMMANDS,
  rollbackCommand,
  historyCommand,
  unlockCommand,
  statusCommand,
  meteorSetupCommand,
  meteorStatusCommand,
  meteorDestroyCommand,
  ...DOCKER_COMMANDS,
  ...PHASE2_COMMANDS,
];

/**
 * Builds the yargs instance with all commands and global options, without parsing. `io`
 * receives all output and `deps` can replace the working directory and the SSH layer.
 * `onReporter` is called with the reporter as soon as a command has created it, so that the
 * caller can mask secrets in errors that reach the top level.
 */
export function buildCli(argv: string[], io: CliIO = defaultIO, deps: MainDeps = {}, onReporter?: (r: Reporter) => void): Argv {
  // Colors only on a real terminal; output captured through a custom `io` stays plain text.
  const tty = io === defaultIO && !!process.stdout.isTTY;
  // Called by each command handler. `init` and `validate` (`needsConfig: false`) get a context
  // without a loaded config, so they work before mup.js exists or while it is invalid.
  const makeCtx = async (args: Record<string, unknown>, needsConfig: boolean) => {
    const reporter = createReporter({ verbose: !!args.verbose, tty, write: io.stdout });
    onReporter?.(reporter);
    const ctxDeps = { cwd: deps.cwd, reporter, print: (t: string) => io.stdout(t + '\n'), sshPoolFactory: deps.sshPoolFactory };
    return needsConfig ? createContext(args, ctxDeps) : createBaseContext(args, ctxDeps);
  };
  const y = yargs(argv)
    .scriptName('comet-deploy')
    .usage('Usage: $0 <command> [options]')
    .version(TOOL_VERSION)
    .alias('v', 'version')
    .help()
    .alias('h', 'help')
    // Strict like MUP: an unknown option or command is an error, not silently ignored.
    // Commands that pass options through to Docker opt out with `strict: false`.
    .strict()
    .strictCommands()
    .recommendCommands()
    .option('config', { type: 'string', describe: 'Path to mup.js / mup.json', global: true })
    .option('settings', { type: 'string', describe: 'Path to the Meteor settings file', global: true })
    .option('servers', { type: 'string', describe: 'Only these servers (space or comma separated)', global: true })
    .option('verbose', { type: 'boolean', describe: 'Show the output of remote commands', global: true })
    .option('show-hook-names', { type: 'boolean', describe: 'Print the names of the available hooks', global: true });
  registerCommands(y, COMMANDS, makeCtx);
  return y
    // Hidden default command: a bare `comet-deploy` ends with an error and a hint instead of
    // printing nothing. Strict mode normally rejects an unknown command before this runs.
    .command(
      '$0',
      false,
      () => {},
      (args) => {
        const [first] = args._;
        if (first !== undefined) throw new CometError(`Unknown command: ${first}`, { hint: 'Run "comet-deploy --help" to list commands.' });
        throw new CometError('Specify a command.', { hint: 'Run "comet-deploy --help" to list commands.' });
      },
    )
    // yargs must not call process.exit() itself (for --help, --version or a parse error):
    // main() returns the exit code, which keeps the CLI usable in-process from tests.
    .exitProcess(false)
    .wrap(Math.min(110, process.stdout.columns || 110));
}

/**
 * Runs the CLI once and resolves to the exit code; it never throws and never exits the process
 * itself. A `CometError` prints `Error: <message>` (and `Hint: <hint>`) and returns its
 * `exitCode`; any other error prints its stack trace and returns 1.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIO = defaultIO, deps: MainDeps = {}): Promise<number> {
  let reporter: Reporter | undefined;
  try {
    let parseError: Error | undefined;
    let output = '';
    // yargs reports its own errors (unknown argument, conflicting options, missing
    // subcommand) through this callback, with the usage text in `out`; `out` also carries the
    // --help and --version text. An error thrown by a command handler rejects parseAsync
    // instead and goes straight to the catch below.
    await buildCli(argv, io, deps, (r) => (reporter = r)).parseAsync(argv, {}, (err, _args, out) => {
      if (err) parseError = err;
      if (out) output = out;
    });
    if (parseError) {
      if (output) io.stderr(output + '\n');
      // As a CometError it prints without a stack trace and exits 1.
      throw parseError instanceof CometError ? parseError : new CometError(parseError.message);
    }
    if (output) io.stdout(output + '\n');
    return 0;
  } catch (err) {
    return reportError(err, io, (t) => (reporter ? reporter.mask(t) : t));
  }
}

/**
 * Prints an error that reached the top level and returns its exit code. A `CometError` is an
 * expected failure (bad config, failed step) and prints without a stack trace; anything else
 * is a bug and prints the stack. Everything goes through `mask`, because error messages can
 * contain env values, passwords or remote output.
 */
function reportError(err: unknown, io: CliIO, mask: (t: string) => string): number {
  if (err instanceof CometError) {
    io.stderr(mask(`Error: ${err.message}\n`));
    if (err.hint) io.stderr(mask(`Hint: ${err.hint}\n`));
    return err.exitCode;
  }
  const e = err as Error;
  io.stderr(mask(`Unexpected error: ${e?.stack ?? String(err)}\n`));
  return 1;
}

// Run only when started as the bin script, not when a test imports this module.
if (isEntryPoint(process.argv[1], import.meta.url)) {
  void main().then((code) => {
    // exitCode instead of exit(): stdout pipes are asynchronous on macOS and would be cut off.
    process.exitCode = code;
    // Safety net: if a handle that was not closed (socket, timer, child process) keeps the
    // event loop alive, exit anyway after 3 s. unref() so this timer does not keep it alive.
    setTimeout(() => process.exit(code), 3000).unref();
  });
}
