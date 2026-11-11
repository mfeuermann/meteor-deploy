/**
 * The command module contract and its wiring into yargs. Each command module declares its
 * name, help text, options and a `run` function; `registerCommands` turns the modules into
 * yargs commands (with `meteor …` / `docker …` as subcommand groups), creates the context for
 * each invocation and always closes the SSH connections when the command ends.
 */
import type { Argv } from 'yargs';
import type { BaseContext, CommandContext, GlobalArgs } from '../core/context.js';

/** Subcommand groups, as in MUP: `comet-deploy meteor <cmd>`, `comet-deploy docker <cmd>`. */
export type CommandGroup = 'meteor' | 'docker' | 'proxy';

/** What every command module declares, whether it needs the config or not. */
interface CommandBase {
  /** yargs command string, e.g. `logs` or `ssh [server] [command..]`. */
  command: string;
  /** Help text; `false` hides the command from `--help`, like MUP's hidden commands. */
  describe: string | false;
  /** Registers the command as `<group> <command>` instead of at the top level. */
  group?: CommandGroup;
  /** Adds the command's own options. */
  builder?: (y: Argv) => Argv;
  /** `false` passes unknown options through in argv (e.g. `logs -f --tail 50`). */
  strict?: boolean;
}

/**
 * A command that needs the project: `run` gets a `CommandContext` with the loaded and
 * validated config, the SSH pool and the command runner. This is the default when
 * `needsConfig` is omitted.
 */
export interface ConfigCommand extends CommandBase {
  needsConfig?: true;
  run(ctx: CommandContext, argv: Record<string, unknown>): Promise<void>;
}

/** A command that runs without loading the config (`init`, `validate`, the phase 2 placeholders). */
export interface NoConfigCommand extends CommandBase {
  needsConfig: false;
  run(ctx: BaseContext, argv: Record<string, unknown>): Promise<void>;
}

/** Any command module; `needsConfig` decides which context `run` receives. */
export type CommandModule = ConfigCommand | NoConfigCommand;

/**
 * Creates the context for one command invocation: a `CommandContext` when `needsConfig` is
 * true (throws a `CometError` when the config is missing or has errors), else a `BaseContext`.
 */
export type MakeContext = (argv: GlobalArgs & Record<string, unknown>, needsConfig: boolean) => Promise<BaseContext | CommandContext>;

const GROUP_DESCRIPTIONS: Record<CommandGroup, string> = {
  meteor: 'Meteor app commands',
  docker: 'Docker commands',
  proxy: 'Reverse proxy commands',
};

/**
 * Registers one command module on `y`. Its handler creates the context, runs the command and
 * closes every SSH connection the command opened, also when it throws.
 */
function addCommand(y: Argv, m: CommandModule, makeCtx: MakeContext): Argv {
  const builder = (yy: Argv) => {
    const b = m.builder ? m.builder(yy) : yy;
    return m.strict === false ? b.strict(false) : b;
  };
  const handler = async (argv: Record<string, unknown>) => {
    const needsConfig = m.needsConfig !== false;
    const ctx = await makeCtx(argv as GlobalArgs & Record<string, unknown>, needsConfig);
    try {
      // MUP prints the hook names while it runs the command. Without hook support there are no
      // names to print, so comet-deploy says so and does not run the command at all.
      if (argv['show-hook-names']) {
        ctx.reporter.info('Hooks are not supported yet: they are planned for phase 2 of comet-deploy.');
        return;
      }
      // Commands such as logs, restart and rollback print app output but never load the
      // settings; their values must be masked there too.
      if ('maskSettings' in ctx) ctx.maskSettings();
      await m.run(ctx as CommandContext, argv);
    } finally {
      // Only a CommandContext has an SSH pool. A failing close must not hide the command's error.
      if ('ssh' in ctx) await ctx.ssh.closeAll().catch(() => {});
    }
  };
  // The yargs typings have one overload for a string description and another for `false`
  // (hidden command), none for the union; at runtime yargs accepts both.
  return y.command(m.command, m.describe as string, builder, handler);
}

/**
 * Registers `modules` on `y`: modules without a `group` as top-level commands, the others as
 * subcommands of their group command (`meteor`, `docker`). A group called without a
 * subcommand fails with "Specify a <group> command.". Returns `y`.
 */
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
