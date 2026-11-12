/**
 * MUP's built-in MongoDB (`mongo` section): names on the server and the scripts of MUP
 * 1.5.11's mongo plugin (`lib/plugins/mongo`), copied byte for byte into
 * `templates/mup/mongo/` and rendered with the same EJS and variables, so a start script
 * written by comet-deploy is the one MUP would write (MUP restarts MongoDB when they differ).
 */
import type { NormalizedConfig } from '../config/types.js';
import { renderTemplate } from '../remote/render.js';

/** The MongoDB container; the app reaches it through `--link=mongodb:mongodb`. */
export const MONGO_CONTAINER = 'mongodb';
export const MONGO_DIR = '/opt/mongodb';
/** Written by `mongo setup`; `mongo-start.sh` runs it when it differs from the current one. */
export const MONGO_START_NEW = `${MONGO_DIR}/mongo-start-new.sh`;
/** The start script the running container was created from. */
export const MONGO_START_CURRENT = `${MONGO_DIR}/mongo-start-current.sh`;

/**
 * The MongoDB shell in the `mongo:<version>` image: `mongosh` above major version 5, else the
 * legacy `mongo`. MUP compares the first version part, a string, with the number 5, so a tag
 * such as `latest` gives `mongo`; kept as MUP does it, since the result is part of the script.
 */
export function mongoShellCommand(version: string): 'mongo' | 'mongosh' {
  return (version.split('.')[0] as unknown as number) > 5 ? 'mongosh' : 'mongo';
}

/** The host directory with the data (`mongo.dataPath`, default as MUP). */
export function mongoDataPath(mongo: Record<string, any>): string {
  return mongo.dataPath || '/var/lib/mongodb';
}

/** MUP's `templates/start.sh` for this `mongo` section: the file uploaded to MONGO_START_NEW. */
export function renderMongoStartScript(mongo: Record<string, any>): Promise<string> {
  const version = String(mongo.version);
  return renderTemplate('mup/mongo/templates/start.sh', {
    mongoVersion: version,
    mongoshCmd: mongoShellCommand(version),
    mongoDbDir: mongoDataPath(mongo),
  });
}

/** One of MUP's mongo scripts that take no variables. */
export function renderMongoAsset(name: 'mongo-setup.sh' | 'mongo-start.sh' | 'mongo-stop.sh'): Promise<string> {
  return renderTemplate(`mup/mongo/${name}`, {});
}

/** The keys of `mongo.servers`, filtered by `--servers` (null = all); empty without `mongo`. */
export function mongoServers(c: NormalizedConfig, filter: string[] | null): string[] {
  const all = Object.keys((c.mongo?.servers as Record<string, unknown>) ?? {});
  return filter ? all.filter((s) => filter.includes(s)) : all;
}
