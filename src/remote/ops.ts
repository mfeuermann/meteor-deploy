/**
 * Remote operations on one server: server facts, the deploy lock, image version tags and
 * retagging, the config snapshot and the deploy history. Each operation renders a
 * `templates/comet/*.sh` script, runs it over SSH (piped to `bash -s` unless noted) and parses
 * what it prints. Every value reaches the shell single-quoted through `q()` in the templates
 * (except validated numbers and version tags); JSON payloads go through SFTP or stdin, never
 * the command text.
 */
import { randomBytes } from 'node:crypto';
import { VERSION_RE } from '../build/version.js';
import { CometError } from '../core/errors.js';
import type { SshConnection } from '../ssh/connection.js';
import { renderTemplate } from './render.js';

/**
 * POSIX shell single-quoting: wraps `s` in `'…'` and writes each `'` as `'\''` (close the
 * quote, an escaped quote, reopen). The result is one literal word whatever `s` contains
 * (`$`, backticks, newlines). This is the `q()` every comet template gets.
 */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Shell argument: as is when it only has safe characters (keeps commands readable in logs),
 * otherwise single-quoted. Meant for argument positions; as a command's first word `a=b`
 * would be a variable assignment.
 */
export function shArg(s: string): string {
  return /^[A-Za-z0-9._/:@=+-]+$/.test(s) ? s : shq(s);
}

/** Renders `templates/comet/<name>` with `q` (= `shq`) available to the template. */
function comet(name: string, vars: Record<string, unknown>): Promise<string> {
  return renderTemplate(`comet/${name}`, { q: shq, ...vars });
}

/** Renders a `templates/comet/*` script (values are passed through `q()` = shell single-quoting). */
export const cometScript = comet;

// What comet-deploy adds to MUP's server layout. All files live in /opt/<app>/config next to
// MUP's start.sh and env.list; MUP never reads them, so the server stays usable with MUP:
//   deploy.lock/            the deploy lock; a directory because `mkdir` is atomic
//   deploy.lock/info.json   who holds it (LockInfo)
//   deploy-history.jsonl    one HistoryEntry per line, appended by every deploy, reconfig,
//                           restart and rollback that ran on this server
//   .prev/                  start.sh and env.list as they were before the last activation
//                           (mode 700, because env.list holds secrets)
// `meteor setup` hands /opt/<app> to the SSH user, so these are handled without sudo.
// Images: the repository mup-<lowercase app> keeps MUP's tags :latest (what start.sh runs) and
// :previous (what MUP's deploy check reverts to), plus one tag per kept version
// (YYYYMMDD-HHMMSS[-sha7][-dirty]) for rollback, which MUP ignores. `meteor destroy` removes
// all of it.
const configDir = (appName: string) => `/opt/${appName}/config`;
const lockDir = (appName: string) => `${configDir(appName)}/deploy.lock`;
const historyFile = (appName: string) => `${configDir(appName)}/deploy-history.jsonl`;

/**
 * Throws CometError unless `version` is a comet-deploy version tag, so `latest`, `previous`
 * or any other tag can never be activated as a version.
 */
function assertVersion(version: string): void {
  if (!VERSION_RE.test(version)) throw new CometError(`Invalid version "${version}" (expected YYYYMMDD-HHMMSS[-sha7][-dirty]).`);
}

// --- facts ---

/** What the preflight checks need to know about a server (printed by facts.sh). */
export interface ServerFacts {
  /** `uname -m`, e.g. `x86_64` or `aarch64`. */
  arch: string;
  /**
   * Docker server version; the client version when the daemon cannot be reached; null when
   * Docker is not installed.
   */
  dockerVersion: string | null;
  /** `sudo docker info` works (the daemon runs and sudo needs no password). */
  dockerRunning: boolean;
  /** Free bytes on the filesystem of Docker's data root; null when the daemon is not reachable. */
  dockerRootFreeBytes: number | null;
  /** Whether bash exists: every other remote script is piped to `bash -s`. */
  hasBash: boolean;
  /** `ok`: sudo works without a password; `password`: it asks for one; `missing`: not installed. */
  sudo: 'ok' | 'password' | 'missing';
  /** Whether `/opt/<app>/config` exists (`setup` was run); undefined when it was not asked for. */
  appSetup?: boolean;
  /** Whether the reverse proxy container `mup-nginx-proxy` runs; undefined when it was not asked for. */
  proxyRunning?: boolean;
}

/**
 * Parses the `key=value` lines of facts.sh. Lenient: unknown keys are ignored, a missing value
 * becomes null / false / '' and a missing `sudo` line counts as `ok`.
 */
export function parseFacts(stdout: string): ServerFacts {
  const kv = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const free = kv.get('docker_free');
  const freeNum = free ? Number(free) : NaN;
  return {
    arch: kv.get('arch') ?? '',
    dockerVersion: kv.get('docker') || null,
    dockerRunning: kv.get('docker_running') === '1',
    dockerRootFreeBytes: Number.isFinite(freeNum) ? freeNum : null,
    hasBash: kv.get('bash') === '1',
    sudo: kv.get('sudo') === 'password' ? 'password' : kv.get('sudo') === 'missing' ? 'missing' : 'ok',
    ...(kv.has('app_setup') ? { appSetup: kv.get('app_setup') === '1' } : {}),
    ...(kv.has('proxy_running') ? { proxyRunning: kv.get('proxy_running') === '1' } : {}),
  };
}

/**
 * Reads the facts of one server; with `appName` also whether the app was set up there, with
 * `o.proxyName` whether that proxy container runs. Throws CometError when the script itself fails.
 */
export async function serverFacts(conn: SshConnection, appName?: string, o: { proxyName?: string } = {}): Promise<ServerFacts> {
  // `sh -s`: works even where bash is missing, which is one of the facts.
  const vars = { configDir: appName === undefined ? null : configDir(appName), proxyName: o.proxyName ?? null };
  const r = await conn.exec('sh -s', { stdin: await comet('facts.sh', vars) });
  if (r.code !== 0) throw new CometError(`[${conn.name}] Cannot read server facts: ${r.stderr.trim() || `exit ${r.code}`}`);
  return parseFacts(r.stdout);
}

// --- lock ---

/** Contents of `deploy.lock/info.json`: who holds the lock, shown to anyone else who tries. */
export interface LockInfo {
  /** git `user.name` of the deployer, otherwise the OS user. */
  user: string;
  /** Host name of the machine the command runs on. */
  machine: string;
  /** Process ID of the comet-deploy process on that machine. */
  pid: number;
  /** ISO timestamp. */
  startedAt: string;
  /** The command that took the lock, e.g. `deploy` or `rollback`. */
  command: string;
  /** `comet-deploy@<version>`. */
  tool: string;
}

/**
 * Parses info.json; null when it is empty or not a JSON object (it is moved into the lock
 * directory only after `mkdir`, so a reader can see the directory without it).
 */
function parseHolder(text: string): LockInfo | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as LockInfo) : null;
  } catch {
    return null;
  }
}

/** Splits script output into its first line (a status word such as `held`) and the rest. */
function splitStatus(stdout: string): { status: string; rest: string } {
  const trimmed = stdout.replace(/^\s+/, '');
  const nl = trimmed.indexOf('\n');
  return nl < 0 ? { status: trimmed.trim(), rest: '' } : { status: trimmed.slice(0, nl).trim(), rest: trimmed.slice(nl + 1).trim() };
}

/**
 * The app's config directory is missing (or cannot be written), so the server was not set up
 * with `comet-deploy setup` (or `meteor setup`) yet. Commands that may run before the app setup,
 * like `proxy setup`, skip the lock on such a server.
 */
export class SetupMissingError extends CometError {}

/**
 * Tries to take the deploy lock on one server. The holder info is first uploaded by SFTP to a
 * uniquely named temp file (so it never passes through a shell); lock-acquire.sh then creates
 * the lock directory with `mkdir`, which succeeds for exactly one of several concurrent
 * deployers, and moves the file into it. Returns `{ ok: false, holder }` when someone else
 * holds the lock (`holder` is null when unreadable). Throws CometError when the config
 * directory is missing or not writable (`setup` was not run). Locks never expire: `unlock` or
 * `--force-unlock` removes a stale one.
 */
export async function acquireLock(conn: SshConnection, appName: string, info: LockInfo): Promise<{ ok: true } | { ok: false; holder: LockInfo | null }> {
  const tmpInfo = `${configDir(appName)}/.deploy.lock.${randomBytes(6).toString('hex')}.json`;
  try {
    await conn.writeFile(tmpInfo, JSON.stringify(info), 0o600);
  } catch (err) {
    throw new SetupMissingError(`[${conn.name}] Cannot write to ${configDir(appName)}: ${(err as Error).message}`, {
      hint: 'Run "comet-deploy setup" first.',
    });
  }
  const r = await conn.runScriptOrThrow(await comet('lock-acquire.sh', { configDir: configDir(appName), lockDir: lockDir(appName), tmpInfo }), 'Acquiring the deploy lock');
  const { status, rest } = splitStatus(r.stdout);
  if (status === 'acquired') return { ok: true };
  if (status === 'missing-config') {
    throw new SetupMissingError(`[${conn.name}] ${configDir(appName)} does not exist.`, { hint: 'Run "comet-deploy setup" first.' });
  }
  return { ok: false, holder: parseHolder(rest) };
}

/**
 * The lock holder of one server, or null when it is not locked. A lock whose info.json cannot
 * be read still counts as held and gets a placeholder holder.
 */
export async function readLock(conn: SshConnection, appName: string): Promise<LockInfo | null> {
  const r = await conn.runScriptOrThrow(await comet('lock-release.sh', { readOnly: true, lockDir: lockDir(appName) }), 'Reading the deploy lock');
  const { status, rest } = splitStatus(r.stdout);
  if (status !== 'held') return null;
  return parseHolder(rest) ?? { user: 'unknown', machine: 'unknown', pid: 0, startedAt: '', command: '', tool: '' };
}

/**
 * Removes the lock directory whoever holds it; the caller decides that this is safe (its own
 * lock, `unlock`, `--force-unlock`).
 */
export async function releaseLock(conn: SshConnection, appName: string): Promise<void> {
  await conn.runScriptOrThrow(await comet('lock-release.sh', { readOnly: false, lockDir: lockDir(appName) }), 'Releasing the deploy lock');
}

// --- image versions ---

/**
 * The tags of `mup-<lc>` on one server. The IDs are the short ones `docker images` prints:
 * they compare with each other, not with the full IDs in ImageTags.
 */
export interface ImageVersions {
  /** Image behind :latest, null when there is no such tag. */
  latestId: string | null;
  /** Image behind :previous, null when there is no such tag. */
  previousId: string | null;
  /** Version tags only (other tags are ignored), newest first. */
  versions: Array<{ tag: string; id: string }>;
}

/** Parses `<tag> <id>` lines as printed by versions.sh (listing mode) and status.sh. */
export function parseVersions(stdout: string): ImageVersions {
  const result: ImageVersions = { latestId: null, previousId: null, versions: [] };
  for (const line of stdout.split('\n')) {
    const [tag, id] = line.trim().split(/\s+/);
    if (!tag || !id) continue;
    if (tag === 'latest') result.latestId = id;
    else if (tag === 'previous') result.previousId = id;
    else if (VERSION_RE.test(tag)) result.versions.push({ tag, id });
  }
  // A version starts with a fixed-width timestamp, so string order is time order.
  result.versions.sort((a, b) => (a.tag < b.tag ? 1 : a.tag > b.tag ? -1 : 0));
  return result;
}

/** The tags of `localRepo` on one server (versions.sh with nothing to remove lists them). */
export async function listVersions(conn: SshConnection, localRepo: string): Promise<ImageVersions> {
  const r = await conn.runScriptOrThrow(await comet('versions.sh', { repo: localRepo, remove: [] }), 'Listing image versions');
  return parseVersions(r.stdout);
}

/**
 * Version tags to remove: every tag in `failed` (versions that never ran
 * healthy, so they do not use up a kept slot) and the rest beyond the newest
 * `keep`. Images behind :latest / :previous are never removed.
 */
export function selectVersionsToRemove(v: ImageVersions, keep: number, failed: ReadonlySet<string> = new Set()): string[] {
  const protectedId = (id: string) => id === v.latestId || id === v.previousId;
  const kept = v.versions.filter((x) => !failed.has(x.tag)).slice(0, Math.max(0, keep));
  return v.versions.filter((x) => !kept.includes(x) && !protectedId(x.id)).map((x) => x.tag);
}

/** Removes old version tags (see `selectVersionsToRemove`); returns the removed tags. */
export async function pruneVersions(conn: SshConnection, localRepo: string, keep: number, o: { failed?: ReadonlySet<string> } = {}): Promise<string[]> {
  const v = await listVersions(conn, localRepo);
  const remove = selectVersionsToRemove(v, keep, o.failed);
  if (remove.length === 0) return [];
  // Not runScriptOrThrow: a tag Docker refuses to remove (e.g. still used by a container) is
  // skipped without failing the deploy, and only the tags reported as removed are returned.
  const r = await conn.runScript(await comet('versions.sh', { repo: localRepo, remove }));
  return r.stdout
    .split('\n')
    .map((l) => /^removed (\S+)$/.exec(l.trim())?.[1])
    .filter((t): t is string => !!t);
}

/**
 * Removes dangling (untagged) images, like MUP's Prepare Bundle does on every
 * deploy. Old base images and images that lost their :previous tag pile up
 * otherwise. Failures are ignored: it is housekeeping, not part of the deploy.
 */
export async function pruneImages(conn: SshConnection): Promise<void> {
  await conn.exec('sudo docker image prune -f >/dev/null 2>&1 || true');
}

/**
 * Full image IDs (`sha256:…`, from `docker image inspect`) behind :latest / :previous before an
 * activation ('' = no such tag), so a failed activation can put both tags back exactly.
 */
export interface ImageTags {
  latestId: string;
  previousId: string;
}

/** A Docker image ID, short or full, with or without `sha256:`. */
const IMAGE_ID_RE = /^(sha256:)?[0-9a-f]{12,64}$/;

/** Reads the `before-latest=` / `before-previous=` lines that retag.sh prints. */
function parseTagsBefore(stdout: string): ImageTags {
  const get = (k: string) => new RegExp(`^${k}=(\\S*)\\s*$`, 'm').exec(stdout)?.[1] ?? '';
  return { latestId: get('before-latest'), previousId: get('before-previous') };
}

/**
 * latest → previous (when latest is another image), version → latest. Returns what the tags
 * named before. Used by deploy and by rollback to a kept version. Throws CometError for an
 * invalid version or when the image is not on the server; retag.sh moves :latest last, so
 * the running image keeps it when anything fails.
 */
export async function retagActivate(conn: SshConnection, localRepo: string, version: string): Promise<ImageTags> {
  assertVersion(version);
  const r = await conn.runScriptOrThrow(await comet('retag.sh', { mode: 'activate', repo: localRepo, version }), `Activating ${localRepo}:${version}`);
  return parseTagsBefore(r.stdout);
}

/** Rollback to :previous: swaps latest and previous. Returns the tags before, or null when there is no previous image. */
export async function retagSwap(conn: SshConnection, localRepo: string): Promise<ImageTags | null> {
  const r = await conn.runScriptOrThrow(await comet('retag.sh', { mode: 'swap', repo: localRepo }), `Rolling ${localRepo} back to :previous`);
  return r.stdout.includes('swapped') ? parseTagsBefore(r.stdout) : null;
}

/**
 * Puts :latest / :previous back on exactly the images they named before (undoes an
 * activation); an empty `previousId` removes :previous. The IDs come from the server's own
 * output, but they are checked before going back into a shell command: throws CometError when
 * one is not an image ID (an empty `latestId` included) or when the script fails.
 */
export async function retagRestore(conn: SshConnection, localRepo: string, tags: ImageTags): Promise<void> {
  if (!IMAGE_ID_RE.test(tags.latestId) || (tags.previousId !== '' && !IMAGE_ID_RE.test(tags.previousId))) {
    throw new CometError(`Invalid image id to restore: ${tags.latestId} / ${tags.previousId}`);
  }
  await conn.runScriptOrThrow(await comet('retag.sh', { mode: 'restore', repo: localRepo, ...tags }), `Restoring ${localRepo}:latest`);
}

// --- config snapshot ---

/**
 * Copies config/start.sh and env.list to config/.prev before an activation rewrites them.
 * False when there is no start.sh yet (first deploy): a failed activation then has no config
 * to go back to.
 */
export async function snapshotConfig(conn: SshConnection, appName: string): Promise<boolean> {
  const r = await conn.runScriptOrThrow(await comet('snapshot.sh', { configDir: configDir(appName) }), 'Saving the config snapshot');
  return r.stdout.includes('ok');
}

/** Copies the files in config/.prev back into config/; false when there is no snapshot. */
export async function restoreConfigSnapshot(conn: SshConnection, appName: string): Promise<boolean> {
  const r = await conn.runScriptOrThrow(await comet('restore-snapshot.sh', { configDir: configDir(appName) }), 'Restoring the config snapshot');
  return r.stdout.includes('ok');
}

// --- history ---

/** One line of `deploy-history.jsonl`. Each server gets its own entry for each command. */
export interface HistoryEntry {
  /** The version deployed or rolled back to; null when there is none (reconfig, restart). */
  version: string | null;
  action: 'deploy' | 'reconfig' | 'restart' | 'rollback';
  /** This server's outcome; `reverted` = it failed and went back to what ran before. */
  result: 'success' | 'failed' | 'reverted';
  /** When the command started (ISO); with version and action it identifies the command. */
  startedAt: string;
  /** Duration of the whole command, not of this server. */
  durationMs: number;
  /** State of the app's git checkout, when there is one. */
  git?: { commit: string; branch: string; dirty: boolean };
  /** The deployer, as in LockInfo. */
  user: string;
  /** Host name of the machine the command ran on. */
  machine: string;
  /** Every server the command targeted. */
  servers: string[];
  tool: string;
}

/**
 * Appends one entry to the history of one server; throws CometError when that fails. stdin
 * carries the JSON line here, so the script cannot be piped in: the rendered history-append.sh
 * is the exec command itself and therefore one command line, not a `bash -s` script.
 */
export async function appendHistory(conn: SshConnection, appName: string, e: HistoryEntry): Promise<void> {
  const command = (await comet('history-append.sh', { configDir: configDir(appName), file: historyFile(appName) })).trim();
  const r = await conn.exec(command, { stdin: JSON.stringify(e) + '\n' });
  if (r.code !== 0) throw new CometError(`[${conn.name}] Cannot write the deploy history: ${r.stderr.trim()}`);
}

/**
 * The last `limit` entries of one server's history, oldest first (file order). A missing or
 * unreadable file gives an empty list; lines that are not JSON objects are skipped.
 */
export async function readHistory(conn: SshConnection, appName: string, limit: number): Promise<HistoryEntry[]> {
  const n = Math.max(1, Math.floor(limit));
  const r = await conn.runScript(await comet('history-read.sh', { file: historyFile(appName), limit: n }));
  const out: HistoryEntry[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as HistoryEntry);
    } catch {
      // corrupted line (e.g. interrupted write): skip
    }
  }
  return out;
}
