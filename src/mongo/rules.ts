/**
 * Rules for MUP's built-in MongoDB that need no server: whether the config can use it at all
 * (MUP's "one app server on the same host" condition) and whether a change of
 * `mongo.version` can open the existing data.
 */
import type { NormalizedConfig } from '../config/types.js';

/** The machine a server name points to: host plus SSH port, as `uniqueHosts` counts machines. */
function machine(c: NormalizedConfig, server: string): string {
  const s = c.servers[server];
  return `${s?.host ?? server}:${s?.opts?.port ?? 22}`;
}

const EXTERNAL = 'Use an external database: set app.env.MONGO_URL and remove the "mongo" section.';

/**
 * Why MUP's built-in MongoDB cannot work with this config, or null when it can (or there is
 * no `mongo` section). MUP sets it up only for exactly one app server on the same host as the
 * first server of `mongo.servers`, and skips it otherwise; the app container then cannot start,
 * because `--link=mongodb:mongodb` has nothing to link to.
 */
export function builtInMongoProblem(c: NormalizedConfig): string | null {
  if (!c.mongo) return null;
  const app = Object.keys(c.app.servers ?? {});
  const mongo = Object.keys((c.mongo.servers as Record<string, unknown>) ?? {})[0];
  if (app.length !== 1) return `MUP's built-in MongoDB needs exactly one app server (the app has ${app.length}). ${EXTERNAL}`;
  if (mongo === undefined) return `mongo.servers lists no server. ${EXTERNAL}`;
  if (machine(c, mongo) !== machine(c, app[0])) {
    return `MUP's built-in MongoDB must run on the app's server: mongo.servers "${mongo}" is not the same machine as app server "${app[0]}". ${EXTERNAL}`;
  }
  return null;
}

/** The release series of a plain version (`6.0.13` → `6.0`); null for tags such as `7` or `latest`. */
export function releaseSeries(version: string): string | null {
  const m = /^(\d+)\.(\d+)(\.\d+)?$/.exec(version);
  return m ? `${Number(m[1])}.${Number(m[2])}` : null;
}

/**
 * MongoDB's release series in upgrade order. A mongod opens the data of its own series and of
 * the one before it, and only when the data's featureCompatibilityVersion (FCV) is that older
 * series; so an upgrade goes one series at a time, with the FCV raised in between. Source:
 * the "Upgrade a Standalone" / "Upgrade a Replica Set" pages of each release's notes,
 * https://www.mongodb.com/docs/manual/release-notes/ (e.g. 7.0 needs FCV 6.0).
 * Rapid releases (7.1, 7.2, ...) are not in the list; a change to or from one is not checked.
 */
export const MONGO_SERIES: readonly string[] = ['3.0', '3.2', '3.4', '3.6', '4.0', '4.2', '4.4', '5.0', '6.0', '7.0', '8.0'];

const UPGRADE_DOCS = 'https://www.mongodb.com/docs/manual/release-notes/';

/**
 * The series a `series` upgrades to, or null when it is not known. After the last listed series,
 * the next major version (`9.0` after `8.0`) is taken as the next step, so the list does not
 * have to change for every new release.
 */
function nextSeries(series: string): string | null {
  const i = MONGO_SERIES.indexOf(series);
  if (i >= 0 && i < MONGO_SERIES.length - 1) return MONGO_SERIES[i + 1];
  const last = MONGO_SERIES[MONGO_SERIES.length - 1];
  const major = Number(series.split('.')[0]);
  if (i === MONGO_SERIES.length - 1 || (major > Number(last.split('.')[0]) && series.endsWith('.0'))) return `${major + 1}.0`;
  return null;
}

/** Index in upgrade order, also for the major versions after the list; -1 when unknown. */
function order(series: string): number {
  const i = MONGO_SERIES.indexOf(series);
  if (i >= 0) return i;
  const last = MONGO_SERIES[MONGO_SERIES.length - 1];
  const major = Number(series.split('.')[0]);
  const lastMajor = Number(last.split('.')[0]);
  return major > lastMajor && series.endsWith('.0') ? MONGO_SERIES.length - 1 + (major - lastMajor) : -1;
}

/** The mongosh call that sets the FCV (`confirm: true` is required from 7.0 on). */
export function setFcvCommand(series: string): string {
  const confirm = Number(series.split('.')[0]) >= 7 ? ', confirm: true' : '';
  return `db.adminCommand({ setFeatureCompatibilityVersion: "${series}"${confirm} })`;
}

export type VersionVerdict =
  | { kind: 'same' }
  | { kind: 'patch' }
  | { kind: 'upgrade'; from: string; to: string }
  | { kind: 'unknown'; warning: string }
  | { kind: 'refuse'; reason: string };

/**
 * Whether MongoDB `next` can start on data that `current` ran with. `current` is null when
 * MongoDB never ran here (no current start script): anything goes. `fcv` is the running
 * MongoDB's featureCompatibilityVersion, or null when it could not be read.
 */
export function judgeVersionChange(current: string | null, next: string, fcv: string | null): VersionVerdict {
  if (current === null || current === next) return { kind: 'same' };
  const from = releaseSeries(current);
  const to = releaseSeries(next);
  const change = `MongoDB ${current} → ${next}`;
  if (from === null || to === null || order(from) < 0 || order(to) < 0) {
    return { kind: 'unknown', warning: `${change}: the version change was not checked (comet-deploy checks only plain versions of the release series it knows). Make sure the new version can open the data.` };
  }
  if (from === to) return { kind: 'patch' };
  if (order(to) < order(from)) {
    return { kind: 'refuse', reason: `${change} goes to an older release series; ${to} cannot open data that ${from} wrote. Downgrading needs the featureCompatibilityVersion lowered first, see ${UPGRADE_DOCS}` };
  }
  if (nextSeries(from) !== to) {
    return { kind: 'refuse', reason: `${change} skips a release series: MongoDB upgrades one release series at a time (${from} → ${nextSeries(from) ?? '?'} → …), with the featureCompatibilityVersion raised after each step. See ${UPGRADE_DOCS}` };
  }
  // The featureCompatibilityVersion exists from 3.4 on; 3.2 data has none to check.
  if (order(from) < order('3.4')) return { kind: 'upgrade', from, to };
  if (fcv === null) {
    return { kind: 'refuse', reason: `${change}: could not read the featureCompatibilityVersion of the running MongoDB (is it running?). Upgrading to ${to} needs it to be ${from}.` };
  }
  if (fcv !== from) {
    return { kind: 'refuse', reason: `${change}: the data's featureCompatibilityVersion is ${fcv}; upgrading to ${to} needs ${from}. Set it first with "comet-deploy mongo shell" and ${setFcvCommand(from)}` };
  }
  return { kind: 'upgrade', from, to };
}
