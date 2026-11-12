/**
 * The `mongo …` commands, in the order of MUP 1.5.11's mongo plugin (`commands.js`). The work
 * is in `src/mongo/`.
 */
import { mongoSetup, mongoStart, mongoStop } from '../../mongo/setup.js';
import type { CommandModule } from '../registry.js';
import { allowMongoVersionChange } from './setup.js';

const allow = (argv: Record<string, unknown>) => argv['allow-mongo-version-change'] === true;

export const MONGO_COMMANDS: CommandModule[] = [
  {
    command: 'setup',
    describe: 'Prepare MongoDB on the server (MUP describes it as "Installs and starts"; start it with "mongo start" or run "setup")',
    group: 'mongo',
    builder: allowMongoVersionChange,
    run: (ctx, argv) => mongoSetup(ctx, { allowVersionChange: allow(argv) }),
  },
  { command: 'start', describe: 'Start MongoDB', group: 'mongo', builder: allowMongoVersionChange, run: (ctx, argv) => mongoStart(ctx, { allowVersionChange: allow(argv) }) },
  { command: 'stop', describe: 'Stop MongoDB (the data is kept)', group: 'mongo', run: (ctx) => mongoStop(ctx) },
];
