import { CometError } from '../../core/errors.js';
import type { NoConfigCommand } from '../registry.js';

/**
 * MUP commands that belong to phase 2 of comet-deploy. They are registered so
 * that a MUP user gets a clear answer instead of yargs' "Unknown argument".
 */
function planned(command: string, describe: string | false, group?: NoConfigCommand['group']): NoConfigCommand {
  return {
    command,
    describe,
    group,
    needsConfig: false,
    strict: false,
    async run(_ctx, argv) {
      const words = ((argv._ as Array<string | number>) ?? []).map(String).join(' ');
      throw new CometError(`"${words}" is not supported yet: it is planned for phase 2 of comet-deploy.`, {
        hint: 'Meanwhile you can run this command with MUP on the same config and servers.',
      });
    },
  };
}

export const PHASE2_COMMANDS: NoConfigCommand[] = [
  planned('proxy [command..]', 'Reverse proxy commands (planned for phase 2)'),
  planned('mongo [command..]', 'MongoDB commands (planned for phase 2)'),
  planned('ssh [server] [command..]', 'Open a shell on a server (planned for phase 2)'),
  planned('debug', false, 'meteor'),
];
