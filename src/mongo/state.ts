/** What a server says about MUP's built-in MongoDB (templates/comet/mongo-state.sh). */
import { cometScript } from '../remote/ops.js';
import type { SshConnection } from '../ssh/connection.js';
import { CometError } from '../core/errors.js';

export interface MongoState {
  /** `/opt/mongodb/mongo-start-new.sh` exists: `mongo setup` ran, so `mongo start` can work. */
  setUp: boolean;
  /** `MONGO_VERSION` of the new start script (what `mongo start` would run); null without one. */
  newVersion: string | null;
  /** `MONGO_VERSION` of the current start script (what the container was created from). */
  currentVersion: string | null;
  /** The `mongodb` container runs. */
  running: boolean;
  /** The `mongodb` container's id; null when there is none. */
  containerId: string | null;
  /** The running MongoDB's featureCompatibilityVersion; null when not running or not readable. */
  fcv: string | null;
}

/** Parses the key=value lines of mongo-state.sh; unknown lines are ignored, empty values are null. */
export function parseMongoState(stdout: string): MongoState {
  const kv = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const value = (k: string) => kv.get(k) || null;
  return {
    setUp: kv.get('set_up') === '1',
    newVersion: value('new_version'),
    currentVersion: value('current_version'),
    running: kv.get('running') === '1',
    containerId: value('container'),
    fcv: value('fcv'),
  };
}

/** Reads the MongoDB state of the server behind `conn`. Throws CometError when the script fails. */
export async function readMongoState(conn: SshConnection): Promise<MongoState> {
  const r = await conn.runScript(await cometScript('mongo-state.sh', {}));
  if (r.code !== 0) throw new CometError(`[${conn.name}] Cannot read the MongoDB state: ${r.stderr.trim() || `exit ${r.code}`}`);
  return parseMongoState(r.stdout);
}
