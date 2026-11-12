/**
 * The check before the app commands that create or start the app container (mongo design
 * §4.3): with a `mongo` section the app runs with `--link=mongodb:mongodb`, and Docker refuses
 * to start it without a running `mongodb` container. A restart would take the app down and its
 * revert would fail the same way, so the command stops before it touches the app.
 */
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { MONGO_CONTAINER, MONGO_START_NEW } from './render.js';
import { builtInMongoProblem } from './rules.js';

/**
 * The error for one server. The hint depends on whether `mongo-start-new.sh`, the file
 * `mongo-start.sh` needs, exists there; when the config cannot run the built-in MongoDB at all
 * (`problem`), that is said instead.
 */
export function mongoNotRunningMessage(server: string, setUp: boolean, problem: string | null): string {
  const what = `Server "${server}": MongoDB (container "${MONGO_CONTAINER}") is not running.`;
  if (problem) return `${what} ${problem}`;
  return `${what} ${setUp ? 'Start it with: comet-deploy mongo start' : 'Set it up with: comet-deploy setup'}`;
}

/** One command per server: whether the container runs and whether `mongo setup` ran. */
const CHECK = `echo "running=$(sudo docker inspect -f '{{.State.Running}}' ${MONGO_CONTAINER} 2>/dev/null)"; if sudo test -f ${MONGO_START_NEW}; then echo set_up=1; else echo set_up=0; fi`;

/**
 * Throws one CometError that lists every server in `servers` where MongoDB does not run (a
 * server that cannot be reached is listed with its error). Does nothing without a `mongo`
 * section. The servers are asked in parallel.
 */
export async function assertMongoRunning(ctx: CommandContext, servers: string[]): Promise<void> {
  if (!ctx.config.mongo || servers.length === 0) return;
  const problem = builtInMongoProblem(ctx.config);
  const found = await Promise.all(
    servers.map(async (s): Promise<string | null> => {
      try {
        const r = await (await ctx.ssh.get(s)).exec(CHECK);
        if (/^running=true$/m.test(r.stdout)) return null;
        return mongoNotRunningMessage(s, /^set_up=1$/m.test(r.stdout), problem);
      } catch (err) {
        return `Server "${s}": ${(err as Error)?.message ?? String(err)}`;
      }
    }),
  );
  const failed = found.filter((f): f is string => f !== null);
  if (failed.length === 1) throw new CometError(failed[0]);
  if (failed.length > 1) throw new CometError(`MongoDB is not running on ${failed.length} app servers:\n${failed.map((f) => `  - ${f}`).join('\n')}`);
}
