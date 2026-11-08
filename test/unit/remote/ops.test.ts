import { describe, expect, it } from 'vitest';
import { makeVersion, VERSION_RE } from '../../../src/build/version.js';
import { CometError } from '../../../src/core/errors.js';
import {
  acquireLock,
  appendHistory,
  parseFacts,
  parseVersions,
  readHistory,
  readLock,
  retagActivate,
  shq,
  type HistoryEntry,
  type LockInfo,
} from '../../../src/remote/ops.js';
import type { ExecOptions, ExecResult, SshConnection } from '../../../src/ssh/connection.js';

/** Records what would be sent to the server and answers with canned output. */
function fakeConn(answer: (script: string) => string = () => '') {
  const calls: Array<{ kind: 'exec' | 'script' | 'write'; text: string; stdin?: string }> = [];
  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
  const conn = {
    name: 'one',
    host: '192.0.2.1',
    async exec(command: string, o: ExecOptions = {}) {
      calls.push({ kind: 'exec', text: command, stdin: typeof o.stdin === 'string' ? o.stdin : undefined });
      return ok(answer(command));
    },
    async runScript(script: string) {
      calls.push({ kind: 'script', text: script });
      return ok(answer(script));
    },
    async runScriptOrThrow(script: string) {
      calls.push({ kind: 'script', text: script });
      return ok(answer(script));
    },
    async writeFile(path: string, content: string) {
      calls.push({ kind: 'write', text: path, stdin: content });
    },
  };
  return { conn: conn as unknown as SshConnection, calls };
}

const LOCK: LockInfo = { user: 'me', machine: 'mac', pid: 42, startedAt: '2026-11-07T18:30:05.000Z', command: 'deploy', tool: 'comet-deploy@0.1.0' };

describe('makeVersion', () => {
  it('formats UTC time, short sha and dirty flag', () => {
    const v = makeVersion(new Date('2026-11-07T18:30:05Z'), { sha: 'abcdef1234', dirty: true });
    expect(v).toBe('20261107-183005-abcdef1-dirty');
    expect(v).toMatch(VERSION_RE);
  });

  it('works without git', () => {
    expect(makeVersion(new Date('2026-11-07T18:30:05Z'))).toBe('20261107-183005');
    expect(makeVersion(new Date('2026-11-07T18:30:05Z'))).toMatch(VERSION_RE);
    expect('latest').not.toMatch(VERSION_RE);
  });
});

describe('parseFacts', () => {
  it('parses key=value lines into typed facts', () => {
    expect(parseFacts('arch=x86_64\ndocker=27.3.1\ndocker_running=1\ndocker_free=123456\nbash=1\n')).toEqual({
      arch: 'x86_64',
      dockerVersion: '27.3.1',
      dockerRunning: true,
      dockerRootFreeBytes: 123456,
      hasBash: true,
    });
  });

  it('maps empty values to null / false', () => {
    expect(parseFacts('arch=aarch64\ndocker=\ndocker_running=0\ndocker_free=\nbash=0')).toEqual({
      arch: 'aarch64',
      dockerVersion: null,
      dockerRunning: false,
      dockerRootFreeBytes: null,
      hasBash: false,
    });
  });
});

describe('parseVersions', () => {
  it('keeps version tags sorted newest first and resolves latest/previous ids', () => {
    const out = [
      'latest aaa111',
      '20261101-100000-1111111 bbb222',
      'previous bbb222',
      'build ccc333',
      '20261107-183005-abcdef1-dirty aaa111',
      'random-tag ddd444',
      '20261103-120000 eee555',
    ].join('\n');
    expect(parseVersions(out)).toEqual({
      latestId: 'aaa111',
      previousId: 'bbb222',
      versions: [
        { tag: '20261107-183005-abcdef1-dirty', id: 'aaa111' },
        { tag: '20261103-120000', id: 'eee555' },
        { tag: '20261101-100000-1111111', id: 'bbb222' },
      ],
    });
  });

  it('handles an empty listing', () => {
    expect(parseVersions('')).toEqual({ latestId: null, previousId: null, versions: [] });
  });
});

describe('history', () => {
  const entry: HistoryEntry = {
    version: '20261107-183005',
    action: 'deploy',
    result: 'success',
    startedAt: '2026-11-07T18:30:05.000Z',
    durationMs: 1234,
    user: "O'Brien $HOME",
    machine: 'mac',
    servers: ['one'],
    tool: 'comet-deploy@0.1.0',
  };

  it('appends one JSON line through stdin, never through the command text', async () => {
    const { conn, calls } = fakeConn();
    await appendHistory(conn, 'app', entry);
    const call = calls.find((c) => c.kind === 'exec')!;
    expect(call.stdin).toBe(JSON.stringify(entry) + '\n');
    expect(call.text).not.toContain('O');
    expect(call.text).toContain("'/opt/app/config/deploy-history.jsonl'");
  });

  it('skips corrupted lines', async () => {
    const { conn } = fakeConn(() => [JSON.stringify(entry), '{not json', '', '42', JSON.stringify({ ...entry, version: null })].join('\n'));
    const h = await readHistory(conn, 'app', 10);
    expect(h).toHaveLength(2);
    expect(h[0].user).toBe("O'Brien $HOME");
    expect(h[1].version).toBeNull();
  });
});

describe('lock', () => {
  it('acquires via an atomic mkdir with info written by SFTP first', async () => {
    const { conn, calls } = fakeConn(() => 'acquired\n');
    await expect(acquireLock(conn, 'app', LOCK)).resolves.toEqual({ ok: true });
    const write = calls.find((c) => c.kind === 'write')!;
    expect(JSON.parse(write.stdin!)).toEqual(LOCK);
    const script = calls.find((c) => c.kind === 'script')!.text;
    expect(script).toContain("mkdir '/opt/app/config/deploy.lock'");
  });

  it('returns the holder when the lock is taken', async () => {
    const { conn } = fakeConn(() => `held\n${JSON.stringify({ ...LOCK, user: 'other' })}\n`);
    await expect(acquireLock(conn, 'app', LOCK)).resolves.toEqual({ ok: false, holder: { ...LOCK, user: 'other' } });
  });

  it('fails clearly when the app was never set up', async () => {
    const { conn } = fakeConn(() => 'missing-config\n');
    await expect(acquireLock(conn, 'app', LOCK)).rejects.toThrow(/setup/);
  });

  it('reads no lock as null', async () => {
    const { conn } = fakeConn(() => 'none\n');
    await expect(readLock(conn, 'app')).resolves.toBeNull();
  });
});

describe('retag', () => {
  it('rejects a version that is not a comet version tag', async () => {
    const { conn } = fakeConn();
    await expect(retagActivate(conn, 'mup-app', 'latest; rm -rf /')).rejects.toThrow(CometError);
  });

  it('only moves latest to previous when it is a different image', async () => {
    const { conn, calls } = fakeConn();
    await retagActivate(conn, 'mup-app', '20261107-183005');
    const script = calls[0].text;
    expect(script).toContain("REPO='mup-app'");
    expect(script).toContain("VERSION='20261107-183005'");
    expect(script).toMatch(/\{\{\.Id\}\}/);
  });
});

describe('shq', () => {
  it('single-quotes for the shell', () => {
    expect(shq("a'b $x")).toBe(`'a'\\''b $x'`);
  });
});

describe('shArg', () => {
  it('keeps safe arguments readable and quotes the rest', async () => {
    const { shArg } = await import('../../../src/remote/ops.js');
    expect(shArg('/opt/my.app/config/start.sh')).toBe('/opt/my.app/config/start.sh');
    expect(shArg('a b')).toBe(`'a b'`);
    expect(shArg('x;rm')).toBe(`'x;rm'`);
  });
});
