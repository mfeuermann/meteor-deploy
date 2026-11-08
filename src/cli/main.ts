import yargs, { type Argv } from 'yargs';
import { CometError } from '../core/errors.js';
import { TOOL_VERSION } from '../core/version.js';

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const defaultIO: CliIO = {
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
};

/** Builds the yargs instance (without parsing). Commands are registered here. */
export function buildCli(argv: string[], _io: CliIO = defaultIO): Argv {
  return yargs(argv)
    .scriptName('comet-deploy')
    .usage('Usage: $0 <command> [options]')
    .version(TOOL_VERSION)
    .alias('v', 'version')
    .help()
    .alias('h', 'help')
    .strict()
    .strictCommands()
    .recommendCommands()
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
export async function main(argv: string[] = process.argv.slice(2), io: CliIO = defaultIO): Promise<number> {
  try {
    let parseError: Error | undefined;
    let output = '';
    await buildCli(argv, io).parseAsync(argv, {}, (err, _args, out) => {
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
    return reportError(err, io);
  }
}

function reportError(err: unknown, io: CliIO): number {
  if (err instanceof CometError) {
    io.stderr(`Error: ${err.message}\n`);
    if (err.hint) io.stderr(`Hint: ${err.hint}\n`);
    return err.exitCode;
  }
  const e = err as Error;
  io.stderr(`Unexpected error: ${e?.stack ?? String(err)}\n`);
  return 1;
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntry) {
  main().then((code) => process.exit(code));
}
