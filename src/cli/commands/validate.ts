/**
 * `validate [--show] [--scrub]`: loads, normalizes and validates the config and lists every
 * problem, like `mup validate`. It does not connect to any server.
 */
import { scrubConfig } from '../../config/scrub.js';
import { formatIssue, loadProject } from '../../core/context.js';
import { CometError } from '../../core/errors.js';
import type { NoConfigCommand } from '../registry.js';

/**
 * `validate`. Throws a `CometError` (exit 1) on any problem, warnings included, as
 * `mup validate` does. `--show` prints the normalized config with its secrets; `--scrub`
 * prints it with hosts, secrets and names replaced, safe to share.
 */
export const validateCommand: NoConfigCommand = {
  command: 'validate',
  describe: 'Validate the config (exit 1 on any problem)',
  // It loads the config itself: the normal context creation throws on errors before --show
  // could print anything, and does not fail on warnings.
  needsConfig: false,
  builder: (y) =>
    y
      .option('show', { type: 'boolean', describe: 'Print the normalized config' })
      .option('scrub', { type: 'boolean', describe: 'Print the normalized config with hosts and secrets replaced' }),
  async run(ctx, argv) {
    const project = loadProject(argv, ctx.cwd);
    if (argv.show || argv.scrub) {
      const config = argv.scrub ? scrubConfig(project.config) : project.config;
      // print() bypasses the reporter: the JSON must stay exact so it can be piped, and
      // --show is the deliberately unmasked view.
      ctx.print(JSON.stringify(config, null, 2));
    }
    for (const i of project.issues) {
      if (i.severity === 'error') ctx.reporter.error(formatIssue(i));
      else ctx.reporter.warn(formatIssue(i));
    }
    if (project.issues.length > 0) {
      const n = project.issues.length;
      throw new CometError(`${project.configPath} has ${n} problem${n > 1 ? 's' : ''}.`);
    }
    ctx.reporter.info('✓ Config is valid');
  },
};
