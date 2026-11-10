import type { Argv } from 'yargs';
import type { BaseContext, CommandContext, GlobalArgs } from '../core/context.js';

export type CommandGroup = 'meteor' | 'docker' | 'mongo' | 'proxy';

interface CommandBase {
  command: string;
  describe: string | false;
  group?: CommandGroup;
  builder?: (y: Argv) => Argv;
  /** `false` passes unknown options through in argv (e.g. `logs -f --tail 50`). */
  strict?: boolean;
}

export interface ConfigCommand extends CommandBase {
  needsConfig?: true;
  run(ctx: CommandContext, argv: Record<string, unknown>): Promise<void>;
}

export interface NoConfigCommand extends CommandBase {
  needsConfig: false;
  run(ctx: BaseContext, argv: Record<string, unknown>): Promise<void>;
}

export type CommandModule = ConfigCommand | NoConfigCommand;

export type MakeContext = (argv: GlobalArgs & Record<string, unknown>, needsConfig: boolean) => Promise<BaseContext | CommandContext>;

const GROUP_DESCRIPTIONS: Record<CommandGroup, string> = {
  meteor: 'Meteor app commands',
  docker: 'Docker commands',
  mongo: 'MongoDB commands',
  proxy: 'Reverse proxy commands',
};

function addCommand(y: Argv, m: CommandModule, makeCtx: MakeContext): Argv {
  const builder = (yy: Argv) => {
    const b = m.builder ? m.builder(yy) : yy;
    return m.strict === false ? b.strict(false) : b;
  };
  const handler = async (argv: Record<string, unknown>) => {
    const needsConfig = m.needsConfig !== false;
    const ctx = await makeCtx(argv as GlobalArgs & Record<string, unknown>, needsConfig);
    if (argv['show-hook-names']) {
      ctx.reporter.info('Hooks are not supported yet: they are planned for phase 2 of comet-deploy.');
      if ('ssh' in ctx) await ctx.ssh.closeAll();
      return;
    }
    try {
      await m.run(ctx as CommandContext, argv);
    } finally {
      if ('ssh' in ctx) await ctx.ssh.closeAll();
    }
  };
  return y.command(m.command, m.describe as string, builder, handler);
}

/** Registers top-level commands and the `meteor` / `docker` / … groups. */
export function registerCommands(y: Argv, modules: CommandModule[], makeCtx: MakeContext): Argv {
  const groups = new Map<CommandGroup, CommandModule[]>();
  for (const m of modules) {
    if (m.group) groups.set(m.group, [...(groups.get(m.group) ?? []), m]);
    else addCommand(y, m, makeCtx);
  }
  for (const [group, mods] of groups) {
    y.command(group, GROUP_DESCRIPTIONS[group], (yy) => {
      for (const m of mods) addCommand(yy, m, makeCtx);
      return yy.demandCommand(1, `Specify a ${group} command.`);
    });
  }
  return y;
}
