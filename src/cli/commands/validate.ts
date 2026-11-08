import { scrubConfig } from '../../config/scrub.js';
import { formatIssue, loadProject } from '../../core/context.js';
import { CometError } from '../../core/errors.js';
import type { NoConfigCommand } from '../registry.js';

export const validateCommand: NoConfigCommand = {
  command: 'validate',
  describe: 'Validate the config (exit 1 on any problem)',
  needsConfig: false,
  builder: (y) =>
    y
      .option('show', { type: 'boolean', describe: 'Print the normalized config' })
      .option('scrub', { type: 'boolean', describe: 'Print the normalized config with hosts and secrets replaced' }),
  async run(ctx, argv) {
    const project = loadProject(argv, ctx.cwd);
    if (argv.show || argv.scrub) {
      const config = argv.scrub ? scrubConfig(project.config) : project.config;
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
