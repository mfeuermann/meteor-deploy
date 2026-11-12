/**
 * `mongo shell`: the MongoDB shell of the `mongodb` container, interactive over SSH, on the
 * first server of `mongo.servers` (as MUP). It opens the app's database `dbName`; MUP opens
 * `app.name`, which differs when the name has dots (mongo design §2 point 4).
 */
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { shArg } from '../remote/ops.js';
import { runInteractive, type LocalTerminal } from '../ssh/interactive.js';
import { MONGO_CONTAINER, mongoServers, mongoShellCommand } from './render.js';
import { requireMongo } from './setup.js';

export async function mongoShell(ctx: CommandContext, term?: LocalTerminal): Promise<void> {
  await ctx.runner.run('mongo.shell', async () => {
    const mongo = requireMongo(ctx);
    const server = mongoServers(ctx.config, ctx.serverFilter)[0];
    if (!server) throw new CometError('No MongoDB server selected: --servers does not include a server of mongo.servers.');
    const shell = mongoShellCommand(String(mongo.version));
    const command = (tty: boolean) => `sudo docker exec -i${tty ? 't' : ''} ${MONGO_CONTAINER} ${shell} ${shArg(String(mongo.dbName))}`;
    const code = await runInteractive(await ctx.ssh.get(server), command, term);
    if (code !== 0) throw new CometError(`The MongoDB shell exited with code ${code}.`, { exitCode: code });
  });
}
