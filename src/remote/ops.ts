/**
 * Remote operations on one server. Every value reaches the shell single-quoted
 * through `q()` in the templates; JSON payloads go through SFTP or stdin.
 */
import { randomBytes } from 'node:crypto';
import { VERSION_RE } from '../build/version.js';
import { CometError } from '../core/errors.js';
import type { SshConnection } from '../ssh/connection.js';
import { renderTemplate } from './render.js';

export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Shell argument: as is when it only has safe characters, otherwise single-quoted. */
export function shArg(s: string): string {
  return /^[A-Za-z0-9._/:@=+-]+$/.test(s) ? s : shq(s);
}

function comet(name: string, vars: Record<string, unknown>): Promise<string> {
  return renderTemplate(`comet/${name}`, { q: shq, ...vars });
}

/** Renders a `templates/comet/*` script (values are passed through `q()` = shell single-quoting). */
export const cometScript = comet;

const configDir = (appName: string) => `/opt/${appName}/config`;
const lockDir = (appName: string) => `${configDir(appName)}/deploy.lock`;
const historyFile = (appName: string) => `${configDir(appName)}/deploy-history.jsonl`;

function assertVersion(version: string): void {
  if (!VERSION_RE.test(version)) throw new CometError(`Invalid version "${version}" (expected YYYYMMDD-HHMMSS[-sha7][-dirty]).`);
}

// --- facts ---

export interface ServerFacts {
  arch: string;
  dockerVersion: string | null;
  dockerRunning: boolean;
  dockerRootFreeBytes: number | null;
  hasBash: boolean;
  /** `ok`: sudo works without a password; `password`: it asks for one; `missing`: not installed. */
  sudo: 'ok' | 'password' | 'missing';
}

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
  };
}

export async function serverFacts(conn: SshConnection): Promise<ServerFacts> {
  // `sh -s`: works even where bash is missing, which is one of the facts.
  const r = await conn.exec('sh -s', { stdin: await comet('facts.sh', {}) });
  if (r.code !== 0) throw new CometError(`[${conn.name}] Cannot read server facts: ${r.stderr.trim() || `exit ${r.code}`}`);
  return parseFacts(r.stdout);
}

// --- lock ---

export interface LockInfo {
  user: string;
  machine: string;
  pid: number;
  startedAt: string;
  command: string;
  tool: string;
}

function parseHolder(text: string): LockInfo | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as LockInfo) : null;
  } catch {
    return null;
  }
}

function splitStatus(stdout: string): { status: string; rest: string } {
  const trimmed = stdout.replace(/^\s+/, '');
  const nl = trimmed.indexOf('\n');
  return nl < 0 ? { status: trimmed.trim(), rest: '' } : { status: trimmed.slice(0, nl).trim(), rest: trimmed.slice(nl + 1).trim() };
}

export async function acquireLock(conn: SshConnection, appName: string, info: LockInfo): Promise<{ ok: true } | { ok: false; holder: LockInfo | null }> {
  const tmpInfo = `${configDir(appName)}/.deploy.lock.${randomBytes(6).toString('hex')}.json`;
  try {
    await conn.writeFile(tmpInfo, JSON.stringify(info), 0o600);
  } catch (err) {
    throw new CometError(`[${conn.name}] Cannot write to ${configDir(appName)}: ${(err as Error).message}`, {
      hint: 'Run "comet-deploy setup" first.',
    });
  }
  const r = await conn.runScriptOrThrow(await comet('lock-acquire.sh', { configDir: configDir(appName), lockDir: lockDir(appName), tmpInfo }), 'Acquiring the deploy lock');
  const { status, rest } = splitStatus(r.stdout);
  if (status === 'acquired') return { ok: true };
  if (status === 'missing-config') {
    throw new CometError(`[${conn.name}] ${configDir(appName)} does not exist. Run "comet-deploy setup" first.`);
  }
  return { ok: false, holder: parseHolder(rest) };
}

export async function readLock(conn: SshConnection, appName: string): Promise<LockInfo | null> {
  const r = await conn.runScriptOrThrow(await comet('lock-release.sh', { readOnly: true, lockDir: lockDir(appName) }), 'Reading the deploy lock');
  const { status, rest } = splitStatus(r.stdout);
  if (status !== 'held') return null;
  return parseHolder(rest) ?? { user: 'unknown', machine: 'unknown', pid: 0, startedAt: '', command: '', tool: '' };
}

export async function releaseLock(conn: SshConnection, appName: string): Promise<void> {
  await conn.runScriptOrThrow(await comet('lock-release.sh', { readOnly: false, lockDir: lockDir(appName) }), 'Releasing the deploy lock');
}

// --- image versions ---

export interface ImageVersions {
  latestId: string | null;
  previousId: string | null;
  /** Newest first. */
  versions: Array<{ tag: string; id: string }>;
}

export function parseVersions(stdout: string): ImageVersions {
  const result: ImageVersions = { latestId: null, previousId: null, versions: [] };
  for (const line of stdout.split('\n')) {
    const [tag, id] = line.trim().split(/\s+/);
    if (!tag || !id) continue;
    if (tag === 'latest') result.latestId = id;
    else if (tag === 'previous') result.previousId = id;
    else if (VERSION_RE.test(tag)) result.versions.push({ tag, id });
  }
  result.versions.sort((a, b) => (a.tag < b.tag ? 1 : a.tag > b.tag ? -1 : 0));
  return result;
}

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

/** Image IDs behind :latest / :previous before an activation ('' = no such tag). */
export interface ImageTags {
  latestId: string;
  previousId: string;
}

const IMAGE_ID_RE = /^(sha256:)?[0-9a-f]{12,64}$/;

function parseTagsBefore(stdout: string): ImageTags {
  const get = (k: string) => new RegExp(`^${k}=(\\S*)\\s*$`, 'm').exec(stdout)?.[1] ?? '';
  return { latestId: get('before-latest'), previousId: get('before-previous') };
}

/** latest → previous (when latest is another image), version → latest. Returns what the tags named before. */
export async function retagActivate(conn: SshConnection, localRepo: string, version: string): Promise<ImageTags> {
  assertVersion(version);
  const r = await conn.runScriptOrThrow(await comet('retag.sh', { mode: 'activate', repo: localRepo, version }), `Activating ${localRepo}:${version}`);
  return parseTagsBefore(r.stdout);
}

/** previous → latest; false when there is no previous image. */
export async function retagRevert(conn: SshConnection, localRepo: string): Promise<boolean> {
  const r = await conn.runScriptOrThrow(await comet('retag.sh', { mode: 'revert', repo: localRepo }), `Reverting ${localRepo} to :previous`);
  return r.stdout.includes('reverted');
}

/** Rollback to :previous: swaps latest and previous. Returns the tags before, or null when there is no previous image. */
export async function retagSwap(conn: SshConnection, localRepo: string): Promise<ImageTags | null> {
  const r = await conn.runScriptOrThrow(await comet('retag.sh', { mode: 'swap', repo: localRepo }), `Rolling ${localRepo} back to :previous`);
  return r.stdout.includes('swapped') ? parseTagsBefore(r.stdout) : null;
}

/** Puts :latest / :previous back on exactly the images they named before (undoes an activation). */
export async function retagRestore(conn: SshConnection, localRepo: string, tags: ImageTags): Promise<void> {
  if (!IMAGE_ID_RE.test(tags.latestId) || (tags.previousId !== '' && !IMAGE_ID_RE.test(tags.previousId))) {
    throw new CometError(`Invalid image id to restore: ${tags.latestId} / ${tags.previousId}`);
  }
  await conn.runScriptOrThrow(await comet('retag.sh', { mode: 'restore', repo: localRepo, ...tags }), `Restoring ${localRepo}:latest`);
}

/** Rollback to a kept version: same retag as activation. */
export async function retagTo(conn: SshConnection, localRepo: string, version: string): Promise<ImageTags> {
  return retagActivate(conn, localRepo, version);
}

// --- config snapshot ---

export async function snapshotConfig(conn: SshConnection, appName: string): Promise<boolean> {
  const r = await conn.runScriptOrThrow(await comet('snapshot.sh', { configDir: configDir(appName) }), 'Saving the config snapshot');
  return r.stdout.includes('ok');
}

export async function restoreConfigSnapshot(conn: SshConnection, appName: string): Promise<boolean> {
  const r = await conn.runScriptOrThrow(await comet('restore-snapshot.sh', { configDir: configDir(appName) }), 'Restoring the config snapshot');
  return r.stdout.includes('ok');
}

// --- history ---

export interface HistoryEntry {
  version: string | null;
  action: 'deploy' | 'reconfig' | 'restart' | 'rollback';
  result: 'success' | 'failed' | 'reverted';
  startedAt: string;
  durationMs: number;
  git?: { commit: string; branch: string; dirty: boolean };
  user: string;
  machine: string;
  servers: string[];
  tool: string;
}

export async function appendHistory(conn: SshConnection, appName: string, e: HistoryEntry): Promise<void> {
  const command = (await comet('history-append.sh', { configDir: configDir(appName), file: historyFile(appName) })).trim();
  const r = await conn.exec(command, { stdin: JSON.stringify(e) + '\n' });
  if (r.code !== 0) throw new CometError(`[${conn.name}] Cannot write the deploy history: ${r.stderr.trim()}`);
}

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
