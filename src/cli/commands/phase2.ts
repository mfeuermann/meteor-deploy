/**
 * Placeholders for the MUP commands that comet-deploy does not implement yet: `proxy …`,
 * `mongo …`, `ssh` and `meteor debug`.
 */
import { CometError } from '../../core/errors.js';
import type { NoConfigCommand } from '../registry.js';

/**
 * MUP commands that belong to phase 2 of comet-deploy. They are registered so
 * that a MUP user gets a clear answer instead of yargs' "Unknown argument".
 *
 * The placeholder loads no config and accepts any argument or option (`strict: false`), so
 * `proxy logs --tail 5` gets the same answer. `run` always throws a `CometError` (exit 1)
 * that quotes the command words as typed (`"proxy logs"`).
 */
function planned(command: string, describe: string | false, group?: NoConfigCommand['group']): NoConfigCommand {
  return {
    command,
    describe,
    group,
    needsConfig: false,
    strict: false,
    async run(_ctx, argv) {
      // yargs puts the positionals of `[server] [command..]` into their own keys, not into `_`.
      const positionals = [argv.server, ...((argv.command as unknown[] | undefined) ?? [])].filter((x) => x !== undefined);
      const words = [...((argv._ as unknown[]) ?? []), ...positionals].map(String).join(' ');
      throw new CometError(`"${words}" is not supported yet: it is planned for phase 2 of comet-deploy.`, {
        hint: 'Meanwhile you can run this command with MUP on the same config and servers.',
      });
    },
  };
}

/** Listed in `--help`; `meteor debug` under `meteor --help`. */
export const PHASE2_COMMANDS: NoConfigCommand[] = [
  planned('proxy [command..]', 'Reverse proxy commands (planned for phase 2)'),
  planned('mongo [command..]', 'MongoDB commands (planned for phase 2)'),
  planned('ssh [server] [command..]', 'Open a shell on a server (planned for phase 2)'),
  planned('debug', 'Debug the app (planned for phase 2)', 'meteor'),
];
