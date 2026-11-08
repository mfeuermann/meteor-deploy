import yargs, { type Argv } from 'yargs';
import { createBaseContext, createContext, type SshPoolFactory } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { TOOL_VERSION } from '../core/version.js';
import { createReporter, type Reporter } from '../output/reporter.js';
import { initCommand } from './commands/init.js';
import { validateCommand } from './commands/validate.js';
import { registerCommands, type CommandModule } from './registry.js';

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export interface MainDeps {
  cwd?: string;
  sshPoolFactory?: SshPoolFactory;
}

const defaultIO: CliIO = {
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
};

export const COMMANDS: CommandModule[] = [initCommand, validateCommand];

/** Builds the yargs instance (without parsing). Commands are registered here. */
export function buildCli(argv: string[], io: CliIO = defaultIO, deps: MainDeps = {}, onReporter?: (r: Reporter) => void): Argv {
  const tty = io === defaultIO && !!process.stdout.isTTY;
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
    .exitProcess(false)
    .wrap(Math.min(110, process.stdout.columns || 110));
}

/** CLI entry point. Resolves to the process exit code. */
export async function main(argv: string[] = process.argv.slice(2), io: CliIO = defaultIO, deps: MainDeps = {}): Promise<number> {
  let reporter: Reporter | undefined;
  try {
    let parseError: Error | undefined;
    let output = '';
    await buildCli(argv, io, deps, (r) => (reporter = r)).parseAsync(argv, {}, (err, _args, out) => {
      if (err) parseError = err;
      if (out) output = out;
    });
    if (parseError) {
      if (output) io.stderr(output + '\n');
      throw parseError instanceof CometError ? parseError : new CometError(parseError.message);
    }
    if (output) io.stdout(output + '\n');
    return 0;
  } catch (err) {
    return reportError(err, io, (t) => (reporter ? reporter.mask(t) : t));
  }
}

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

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntry) {
  main().then((code) => process.exit(code));
}
