import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeConfig } from '../../src/config/normalize.js';
import { renderMeteorSetup } from '../../src/remote/app-files.js';
import {
  acquireLock,
  appendHistory,
  listVersions,
  pruneVersions,
  readHistory,
  readLock,
  releaseLock,
  restoreConfigSnapshot,
  retagActivate,
  retagRestore,
  retagRevert,
  retagSwap,
  serverFacts,
  snapshotConfig,
  type HistoryEntry,
  type LockInfo,
} from '../../src/remote/ops.js';
import { SshConnection } from '../../src/ssh/connection.js';
import { SshPool } from '../../src/ssh/pool.js';
import { fakeServersConfig, startFakeServers, type FakeServer } from '../harness/fake-servers.js';

const APP = 'opsapp';
const REPO = `mup-${APP}`;
const LOCK: LockInfo = { user: 'tester', machine: 'ci', pid: 1, startedAt: new Date().toISOString(), command: 'deploy', tool: 'comet-deploy@test' };

describe('remote ops on a fake server', () => {
  let server: FakeServer;
  let conn: SshConnection;

  beforeAll(async () => {
    [server] = await startFakeServers(1);
    const [name, cfg] = Object.entries(fakeServersConfig([server], 'password'))[0];
    conn = await SshConnection.connect(name, cfg, { cwd: process.cwd(), basePath: process.cwd() });
    const config = normalizeConfig(
      { servers: { [name]: cfg }, app: { name: APP, path: '/x', servers: { [name]: {} }, env: { ROOT_URL: 'http://a.com' } } },
      { basePath: process.cwd() },
    );
    await conn.runScriptOrThrow(await renderMeteorSetup(config), 'setup');
  });

  afterAll(async () => {
    await conn?.close();
    await server?.stop();
  });

  it('reads facts', async () => {
    const f = await serverFacts(conn);
    expect(f.dockerRunning).toBe(true);
    expect(f.dockerVersion).toMatch(/^\d+\./);
    expect(f.hasBash).toBe(true);
    expect(f.arch).not.toBe('');
    expect(f.sudo).toBe('ok');
  });

  it('locks exclusively', async () => {
    expect(await acquireLock(conn, APP, LOCK)).toEqual({ ok: true });
    expect(await acquireLock(conn, APP, { ...LOCK, user: 'second' })).toEqual({ ok: false, holder: LOCK });
    expect(await readLock(conn, APP)).toEqual(LOCK);
    await releaseLock(conn, APP);
    expect(await readLock(conn, APP)).toBeNull();
    expect(await acquireLock(conn, APP, LOCK)).toEqual({ ok: true });
    await releaseLock(conn, APP);
  });

  it('retags and prunes versions', async () => {
    const tags = ['20260101-000001', '20260101-000002', '20260101-000003', '20260101-000004'];
    for (const [i, t] of tags.entries()) {
      // Distinct tiny images without network access.
      await server.exec(`tar cf - --files-from /dev/null | docker import --change "LABEL v=${i}" - ${REPO}:${t}`);
    }
    await retagActivate(conn, REPO, tags[2]);
    await retagActivate(conn, REPO, tags[3]);
    let v = await listVersions(conn, REPO);
    expect(v.latestId).toBe(v.versions.find((x) => x.tag === tags[3])!.id);
    expect(v.previousId).toBe(v.versions.find((x) => x.tag === tags[2])!.id);

    // Re-activating the same image keeps the real previous.
    await retagActivate(conn, REPO, tags[3]);
    v = await listVersions(conn, REPO);
    expect(v.previousId).toBe(v.versions.find((x) => x.tag === tags[2])!.id);

    const removed = await pruneVersions(conn, REPO, 1);
    expect(removed.sort()).toEqual([tags[0], tags[1]]);
    v = await listVersions(conn, REPO);
    expect(v.versions.map((x) => x.tag)).toEqual([tags[3], tags[2]]);

    expect(await retagRevert(conn, REPO)).toBe(true);
    v = await listVersions(conn, REPO);
    expect(v.latestId).toBe(v.previousId);
  });

  it('rollback to :previous swaps latest and previous (MUP-only server)', async () => {
    const repo = `${REPO}-swap`;
    await server.exec(`tar cf - --files-from /dev/null | docker import --change "LABEL v=prev" - ${repo}:previous`);
    await server.exec(`tar cf - --files-from /dev/null | docker import --change "LABEL v=cur" - ${repo}:latest`);
    const before = await listVersions(conn, repo);
    expect(await retagSwap(conn, repo)).not.toBeNull();
    const after = await listVersions(conn, repo);
    expect(after.latestId).toBe(before.previousId);
    expect(after.previousId).toBe(before.latestId);
    const tags = (await server.exec(`docker images --format '{{.Tag}}' ${repo}`)).stdout;
    expect(tags).not.toContain('comet-swap');
  });

  it('restores exactly the tags from before an activation, also when the same image was re-activated (C2)', async () => {
    const repo = `${REPO}-restore`;
    const [v1, v2, v3] = ['20260201-000001', '20260201-000002', '20260201-000003'];
    for (const [i, t] of [v1, v2, v3].entries()) {
      await server.exec(`tar cf - --files-from /dev/null | docker import --change "LABEL r=${i}" - ${repo}:${t}`);
    }
    await retagActivate(conn, repo, v1);
    await retagActivate(conn, repo, v2);
    const running = await listVersions(conn, repo);
    const id = (t: string) => running.versions.find((x) => x.tag === t)!.id;
    // same image again (a build-cache hit): a revert must not fall back to v1
    const same = await retagActivate(conn, repo, v2);
    await retagRestore(conn, repo, same);
    let v = await listVersions(conn, repo);
    expect([v.latestId, v.previousId]).toEqual([id(v2), id(v1)]);
    // a new version, then undo it
    const before = await retagActivate(conn, repo, v3);
    expect((await listVersions(conn, repo)).latestId).toBe(id(v3));
    await retagRestore(conn, repo, before);
    v = await listVersions(conn, repo);
    expect([v.latestId, v.previousId]).toEqual([id(v2), id(v1)]);
  });

  it('snapshots and restores start.sh / env.list', async () => {
    expect(await snapshotConfig(conn, APP)).toBe(false);
    await conn.writeFile(`/opt/${APP}/config/start.sh`, 'echo one\n');
    await conn.writeFile(`/opt/${APP}/config/env.list`, 'A=1\n', 0o600);
    expect(await snapshotConfig(conn, APP)).toBe(true);
    await conn.writeFile(`/opt/${APP}/config/start.sh`, 'echo two\n');
    await conn.writeFile(`/opt/${APP}/config/env.list`, 'A=2\n');
    expect(await restoreConfigSnapshot(conn, APP)).toBe(true);
    expect((await server.exec(`cat /opt/${APP}/config/start.sh /opt/${APP}/config/env.list`)).stdout).toBe('echo one\nA=1\n');
  });

  it("keeps history values with ' and $ intact", async () => {
    const e: HistoryEntry = {
      version: '20260101-000004',
      action: 'deploy',
      result: 'success',
      startedAt: new Date().toISOString(),
      durationMs: 1,
      user: "O'Brien $HOME `id`",
      machine: 'm',
      servers: ['s1'],
      tool: 'comet-deploy@test',
    };
    await appendHistory(conn, APP, e);
    await appendHistory(conn, APP, { ...e, action: 'rollback' });
    await server.exec(`echo '{broken' >> /opt/${APP}/config/deploy-history.jsonl`);
    const h = await readHistory(conn, APP, 10);
    expect(h).toHaveLength(2);
    expect(h[0]).toEqual(e);
    expect(h[1].action).toBe('rollback');
  });
});

describe('facts for an SSH user whose sudo asks for a password (M13)', () => {
  let server: FakeServer;
  let conn: SshConnection;

  beforeAll(async () => {
    [server] = await startFakeServers(1, { user: 'deployer' });
    await server.exec('rm -f /etc/sudoers.d/deployer');
    const [name, cfg] = Object.entries(fakeServersConfig([server], 'password'))[0];
    conn = await SshConnection.connect(name, cfg, { cwd: process.cwd(), basePath: process.cwd() });
  });

  afterAll(async () => {
    await conn?.close();
    await server?.stop();
  });

  it('reports sudo=password instead of a Docker problem', async () => {
    const f = await serverFacts(conn);
    expect(f.sudo).toBe('password');
  });

  it('replaces a dropped SSH connection with a new one (M8)', async () => {
    const servers = fakeServersConfig([server], 'password');
    const [name] = Object.keys(servers);
    const pool = new SshPool(servers, { cwd: process.cwd(), basePath: process.cwd() });
    try {
      const first = await pool.get(name);
      expect((await first.exec('echo one')).stdout.trim()).toBe('one');
      // kill the server side of every deployer session ("[d]" keeps pkill from matching its own shell)
      await server.exec("pkill -KILL -f 'sshd: [d]eployer'");
      for (let i = 0; i < 50 && first.isAlive; i++) await new Promise((r) => setTimeout(r, 100));
      expect(first.isAlive).toBe(false);
      await expect(first.exec('echo two')).rejects.toThrow(/SSH connection .* closed/);

      const second = await pool.get(name);
      expect(second).not.toBe(first);
      expect((await second.exec('echo three')).stdout.trim()).toBe('three');
    } finally {
      await pool.closeAll();
    }
  });
});
