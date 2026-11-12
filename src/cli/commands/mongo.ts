/**
 * The `mongo …` commands, in the order of MUP 1.5.11's mongo plugin (`commands.js`). The work
 * is in `src/mongo/`.
 */
import { MONGO_CONTAINER, mongoServers } from '../../mongo/render.js';
import { mongoSetup, mongoStart, mongoStop, requireMongo } from '../../mongo/setup.js';
import { mongoShell } from '../../mongo/shell.js';
import { showMongoStatus } from '../../mongo/status.js';
import type { CommandModule } from '../registry.js';
import { logsPassthrough, streamLogs } from './lifecycle.js';
import { allowMongoVersionChange } from './setup.js';
import { overview } from './status.js';

const allow = (argv: Record<string, unknown>) => argv['allow-mongo-version-change'] === true;

export const MONGO_COMMANDS: CommandModule[] = [
  {
    command: 'setup',
    describe: 'Prepare MongoDB on the server (MUP describes it as "Installs and starts"; start it with "mongo start" or run "setup")',
    group: 'mongo',
    builder: allowMongoVersionChange,
    run: (ctx, argv) => mongoSetup(ctx, { allowVersionChange: allow(argv) }),
  },
  {
    command: 'logs',
    describe: 'View MongoDB logs (docker logs options pass through)',
    group: 'mongo',
    strict: false,
    run: (ctx, argv) =>
      ctx.runner.run('mongo.logs', () => {
        requireMongo(ctx);
        return streamLogs(ctx, logsPassthrough(argv, ['mongo', 'logs']), { container: MONGO_CONTAINER, servers: mongoServers(ctx.config, ctx.serverFilter) });
      }),
  },
  { command: 'start', describe: 'Start MongoDB', group: 'mongo', builder: allowMongoVersionChange, run: (ctx, argv) => mongoStart(ctx, { allowVersionChange: allow(argv) }) },
  { command: 'stop', describe: 'Stop MongoDB (the data is kept)', group: 'mongo', run: (ctx) => mongoStop(ctx) },
  { command: 'shell', describe: 'Open the MongoDB shell on the server (database dbName)', group: 'mongo', run: (ctx) => mongoShell(ctx) },
  {
    command: 'status',
    describe: 'View MongoDB status',
    group: 'mongo',
    builder: overview,
    run: (ctx, argv) => {
      requireMongo(ctx);
      return showMongoStatus(ctx, argv.overview === true);
    },
  },
];
