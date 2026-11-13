/**
 * `api.runCommand(key)` of method hooks: runs the comet-deploy command behind a MUP command key,
 * nested in the running command with the same context, runner and hooks, as MUP's `runCommand`
 * (hooks design §4.6).
 */
import type { CommandGroup, ConfigCommand } from '../cli/registry.js';
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { holdsLock } from '../deploy/pipeline.js';
import { COMET_ONLY_KEYS, MUP_COMMAND_KEYS } from './registry.js';

/** Where a key's command is in the CLI, and whether it takes the deploy lock. */
interface HookCommand {
  group: CommandGroup | null;
  name: string;
  locks: boolean;
}

const cmd = (group: CommandGroup | null, name: string, locks = false): HookCommand => ({ group, name, locks });

/**
 * Every key whose command comet-deploy has. MUP's keys are export names, so a few differ from
 * the CLI names (`proxy.leLogs` is `proxy logs-le`). `meteor.prepareBundle` (the distribution
 * without a build) has no command of its own.
 */
export const HOOK_COMMANDS: Record<string, HookCommand> = {
  'default.deploy': cmd(null, 'deploy', true),
  'default.logs': cmd(null, 'logs'),
  'default.reconfig': cmd(null, 'reconfig', true),
  'default.restart': cmd(null, 'restart', true),
  'default.setup': cmd(null, 'setup', true),
  'default.start': cmd(null, 'start'),
  'default.stop': cmd(null, 'stop'),
  'default.status': cmd(null, 'status'),
  'default.rollback': cmd(null, 'rollback', true),
  'docker.setup': cmd('docker', 'setup'),
  'docker.restart': cmd('docker', 'restart'),
  'docker.ps': cmd('docker', 'ps'),
  'docker.status': cmd('docker', 'status'),
  'docker.update': cmd('docker', 'update'),
  'meteor.setup': cmd('meteor', 'setup'),
  'meteor.deploy': cmd('meteor', 'deploy', true),
  'meteor.destroy': cmd('meteor', 'destroy'),
  'meteor.logs': cmd('meteor', 'logs'),
  'meteor.start': cmd('meteor', 'start'),
  'meteor.stop': cmd('meteor', 'stop'),
  'meteor.restart': cmd('meteor', 'restart', true),
  'meteor.status': cmd('meteor', 'status'),
  'meteor.build': cmd('meteor', 'build'),
  'meteor.push': cmd('meteor', 'push', true),
  'meteor.envconfig': cmd('meteor', 'envconfig'),
  'mongo.setup': cmd('mongo', 'setup', true),
  'mongo.logs': cmd('mongo', 'logs'),
  'mongo.start': cmd('mongo', 'start', true),
  'mongo.stop': cmd('mongo', 'stop', true),
  'mongo.shell': cmd('mongo', 'shell'),
  'mongo.status': cmd('mongo', 'status'),
  'proxy.setup': cmd('proxy', 'setup', true),
  'proxy.reconfigShared': cmd('proxy', 'reconfig-shared', true),
  'proxy.logs': cmd('proxy', 'logs'),
  'proxy.leLogs': cmd('proxy', 'logs-le'),
  'proxy.start': cmd('proxy', 'start', true),
  'proxy.stop': cmd('proxy', 'stop', true),
  'proxy.nginxConfig': cmd('proxy', 'nginx-config'),
  'proxy.status': cmd('proxy', 'status'),
};

/** The global options a nested command keeps; the options of the command that runs the hook would not fit it. */
const GLOBAL_OPTIONS = ['config', 'settings', 'servers', 'verbose', 'show-hook-names'];

/**
 * Runs the command of `key` inside the running command.
 *
 * @throws CometError for a key MUP does not have (MUP's text), a key comet-deploy has no
 *   command for, and a locking command while this command holds the deploy lock (it would wait
 *   for itself).
 */
export async function runHookCommand(ctx: CommandContext, key: string): Promise<void> {
  if (!MUP_COMMAND_KEYS.includes(key) && !COMET_ONLY_KEYS.includes(key)) throw new CometError(`Unknown command name: ${key}`);
  const entry = HOOK_COMMANDS[key];
  if (!entry) throw new CometError(`api.runCommand("${key}") is not supported by comet-deploy.`);
  if (entry.locks && holdsLock(ctx)) {
    throw new CometError(
      `api.runCommand("${key}") cannot run while comet-deploy holds the deploy lock (from a hook inside a locked step). Run it from a post.default.deploy hook instead.`,
    );
  }
  // Imported here: the command list imports the context, which imports this module.
  const { COMMANDS } = await import('../cli/main.js');
  const m = COMMANDS.find((c) => c.command.split(' ')[0] === entry.name && (c.group ?? null) === entry.group);
  if (!m || m.needsConfig === false) throw new CometError(`api.runCommand("${key}") is not supported by comet-deploy.`);
  const argv: Record<string, unknown> = { _: entry.group ? [entry.group, entry.name] : [entry.name] };
  for (const o of GLOBAL_OPTIONS) if (ctx.argv[o] !== undefined) argv[o] = ctx.argv[o];
  await (m as ConfigCommand).run(ctx, argv);
}
