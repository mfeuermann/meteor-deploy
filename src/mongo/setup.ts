/**
 * `mongo setup`, `mongo start` and `mongo stop`: MUP 1.5.11's mongo plugin
 * (`lib/plugins/mongo/command-handlers.js`) with its scripts, plus comet-deploy's checks
 * (mongo design §4.1, §4.2, §4.4, §4.6): the reason when MongoDB is skipped, a refused version
 * change, one result line per server, and the app's deploy lock.
 */
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { APP_LOCK_DEPS, withAppLock, type AppLockDeps } from '../deploy/app-lock.js';
import { verboseOutput } from '../output/lines.js';
import { runOnServers } from '../remote/on-servers.js';
import { formatFailureOutput, type ExecResult } from '../ssh/connection.js';
import { MONGO_START_NEW, mongoServers, renderMongoAsset, renderMongoStartScript } from './render.js';
import { builtInMongoProblem, judgeVersionChange, setFcvCommand, type VersionVerdict } from './rules.js';
import { readMongoState, type MongoState } from './state.js';

export interface MongoOptions {
  /** `--allow-mongo-version-change`: a refused version change only warns. */
  allowVersionChange?: boolean;
  /**
   * Set by `setup`, which runs `mongo.setup` and then `mongo.start`: the start does not repeat
   * the reason why MongoDB is skipped, which the setup step printed already.
   */
  fromSetup?: boolean;
  lockDeps?: AppLockDeps;
}

const ALLOW_HINT = 'To change the version anyway (for example with an empty dataPath), add --allow-mongo-version-change.';

/** The `mongo` section, or an error when there is none. */
export function requireMongo(ctx: CommandContext): Record<string, any> {
  if (!ctx.config.mongo) throw new CometError('The config has no "mongo" section.', { hint: "Add MUP's \"mongo\" section to the config to run MongoDB on the app's server." });
  return ctx.config.mongo;
}

/** Applies a version verdict: throws for a refusal (unless allowed), warns for an unchecked change. */
function applyVerdict(ctx: CommandContext, server: string, v: VersionVerdict, allow: boolean | undefined): void {
  if (v.kind === 'refuse') {
    // In the message, not a hint: runOnServers reports each server's error message only.
    if (!allow) throw new CometError(`${v.reason}\n${ALLOW_HINT}`);
    ctx.reporter.warn(`[${server}] ${v.reason} (going ahead: --allow-mongo-version-change)`);
  } else if (v.kind === 'unknown') {
    ctx.reporter.warn(`[${server}] ${v.warning}`);
  }
}

/**
 * The servers to work on, or null when MongoDB is skipped for this config (the reason is
 * printed unless `quiet`). MUP skips its MongoDB when the app does not have exactly one server
 * on the mongo server's machine; comet-deploy says why.
 */
function targetServers(ctx: CommandContext, what: string, quiet: boolean): string[] | null {
  const problem = builtInMongoProblem(ctx.config);
  if (problem) {
    if (!quiet) ctx.reporter.warn(`MongoDB is not ${what}: ${problem}`);
    return null;
  }
  return mongoServers(ctx.config, ctx.serverFilter);
}

/**
 * `mongo.setup`: `mongo-setup.sh` (creates /opt/mongodb), then MUP's start script to
 * /opt/mongodb/mongo-start-new.sh. A version change the data cannot take is refused before
 * anything is written, so a later `mongo start` (or `mup mongo start`) cannot run it either.
 */
export async function mongoSetup(ctx: CommandContext, o: MongoOptions = {}): Promise<void> {
  await ctx.runner.run('mongo.setup', async () => {
    const mongo = ctx.config.mongo;
    if (!mongo) {
      ctx.reporter.info('Not setting up built-in mongodb since there is no mongo config');
      return;
    }
    const servers = targetServers(ctx, 'set up', false);
    if (!servers?.length) return;
    const [setupSh, startSh] = await Promise.all([renderMongoAsset('mongo-setup.sh'), renderMongoStartScript(mongo)]);
    await withAppLock(ctx, 'mongo setup', o.lockDeps ?? APP_LOCK_DEPS, () =>
      ctx.reporter.phase('MongoDB setup', () =>
        runOnServers(ctx, servers, 'mongo setup', async (conn, s) => {
          const state = await readMongoState(conn);
          applyVerdict(ctx, s, judgeVersionChange(state.currentVersion, String(mongo.version), state.fcv), o.allowVersionChange);
          await conn.runScriptOrThrow(setupSh, 'Setting up MongoDB', verboseOutput(ctx.reporter, s));
          await conn.writeFile(MONGO_START_NEW, startSh);
        }),
      ),
    );
  });
}

/**
 * Whether a failed `mongo-start.sh` failed only in its last step, on data that has MUP's
 * replica set already. The step calls `rs.initiate` again; the old `mongo` shell printed
 * "already initialized" and exited 0, but `mongosh` (MongoDB 6 and later) exits 1, so the
 * script gives up after 20 tries with "Failed connecting to mongo to create replica set"
 * although MongoDB runs. MUP's own `mongo start` fails the same way there.
 */
function replicaSetAlreadyThere(r: ExecResult, after: MongoState): boolean {
  return after.running && after.replicaSet === 'meteor' && /Failed connecting to mongo to create replica set/.test(r.stderr);
}

/** One line on what `mongo-start.sh` did, from its output and the state before and after. */
function startResult(before: MongoState, after: MongoState, stdout: string): string {
  if (/^Same start script$/m.test(stdout)) return before.running ? 'MongoDB is up to date (container kept)' : 'MongoDB started';
  if (!before.containerId && !before.currentVersion) return 'MongoDB started';
  const versions = before.currentVersion && after.currentVersion && before.currentVersion !== after.currentVersion ? ` (${before.currentVersion} → ${after.currentVersion})` : '';
  return `MongoDB recreated: the start script changed${versions}`;
}

/**
 * `mongo.start`: MUP's `mongo-start.sh`, which starts a stopped container when the start script
 * did not change, and recreates the container (keeping the data) when it did. The version
 * change it would make is judged from the scripts on the server, which `mup mongo setup` may
 * have written with another version than this config.
 */
export async function mongoStart(ctx: CommandContext, o: MongoOptions = {}): Promise<void> {
  await ctx.runner.run('mongo.start', async () => {
    requireMongo(ctx);
    const servers = targetServers(ctx, 'started', !!o.fromSetup);
    if (!servers?.length) return;
    const startSh = await renderMongoAsset('mongo-start.sh');
    const hints: string[] = [];
    await withAppLock(ctx, 'mongo start', o.lockDeps ?? APP_LOCK_DEPS, () =>
      ctx.reporter.phase('MongoDB start', () =>
        runOnServers(ctx, servers, 'mongo start', async (conn, s) => {
          const before = await readMongoState(conn);
          if (!before.setUp || before.newVersion === null) {
            throw new CometError('MongoDB is not set up on this server (no /opt/mongodb/mongo-start-new.sh). Set it up with: comet-deploy mongo setup');
          }
          const verdict = judgeVersionChange(before.currentVersion, before.newVersion, before.fcv);
          applyVerdict(ctx, s, verdict, o.allowVersionChange);
          const r = await conn.runScript(startSh, verboseOutput(ctx.reporter, s));
          const after = await readMongoState(conn);
          if (r.code !== 0 && !replicaSetAlreadyThere(r, after)) {
            throw new CometError(`[${s}] Starting MongoDB failed (exit code ${r.code}):\n${formatFailureOutput(r)}`);
          }
          if (verdict.kind === 'upgrade') {
            hints.push(`[${s}] Before the next MongoDB upgrade, set the feature compatibility version: comet-deploy mongo shell, then ${setFcvCommand(verdict.to)}`);
          }
          return startResult(before, after, r.stdout);
        }),
      ),
    );
    for (const h of hints) ctx.reporter.info(h);
  });
}

/** `mongo.stop`: MUP's `mongo-stop.sh` (shuts mongod down, removes the container, keeps the data). */
export async function mongoStop(ctx: CommandContext, o: MongoOptions = {}): Promise<void> {
  await ctx.runner.run('mongo.stop', async () => {
    requireMongo(ctx);
    const servers = mongoServers(ctx.config, ctx.serverFilter);
    if (!servers.length) return;
    const stopSh = await renderMongoAsset('mongo-stop.sh');
    await withAppLock(ctx, 'mongo stop', o.lockDeps ?? APP_LOCK_DEPS, () =>
      ctx.reporter.phase('MongoDB stop', () =>
        runOnServers(ctx, servers, 'mongo stop', async (conn, s) => {
          // MUP's script ends with `docker rm -f mongodb`, which fails without a container.
          if (!(await readMongoState(conn)).containerId) return 'MongoDB is not running';
          await conn.runScriptOrThrow(stopSh, 'Stopping MongoDB', verboseOutput(ctx.reporter, s));
          return 'MongoDB stopped (the data is kept)';
        }),
      ),
    );
  });
}
