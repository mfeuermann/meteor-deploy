import { describe, expect, it } from 'vitest';
import { createContext } from '../../../src/core/context.js';
import { lockServers } from '../../../src/deploy/pipeline.js';
import { HOOK_COMMANDS, runHookCommand } from '../../../src/hooks/commands.js';
import { KEYS_COMET_DOES_NOT_RUN, MUP_COMMAND_KEYS } from '../../../src/hooks/registry.js';
import { createReporter } from '../../../src/output/reporter.js';
import type { ExecResult, SshConnection } from '../../../src/ssh/connection.js';
import { tempDir } from '../../helpers/fs.js';

async function setup(extra = '') {
  const dir = tempDir({
    '.deploy/mup.js': `module.exports = {
      servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw' } },
      app: { name: 'myapp', path: '../app', servers: { one: {} }, env: { ROOT_URL: 'http://a.com', MONGO_URL: 'mongodb://db/x' }, docker: { image: 'zodern/meteor' } },
      ${extra}
    };`,
    '.deploy/settings.json': '{}',
  });
  const execs: string[] = [];
  const answer = async (cmd: string): Promise<ExecResult> => (execs.push(cmd), { code: 0, stdout: '', stderr: '' });
  const conn = { name: 'one', exec: answer, runScript: answer, runScriptOrThrow: answer } as unknown as SshConnection;
  const ctx = await createContext(
    { config: '.deploy/mup.js', tail: 5 },
    { cwd: dir, reporter: createReporter({ verbose: false, tty: false, write: () => {} }), sshPoolFactory: () => ({ get: async () => conn, closeAll: async () => {} }) },
  );
  return { ctx, execs };
}

describe('api.runCommand', () => {
  it('runs the command of a key with its hooks', async () => {
    const seen: string[] = [];
    (globalThis as { __seen?: string[] }).__seen = seen;
    const s = await setup("hooks: { 'pre.docker.ps': () => void globalThis.__seen.push('pre.docker.ps') },");
    await runHookCommand(s.ctx, 'docker.ps');
    delete (globalThis as { __seen?: string[] }).__seen;
    expect(s.ctx.runner.history).toEqual(['docker.ps']);
    expect(seen).toEqual(['pre.docker.ps']);
    // Only the global options are passed on, not the ones of the command that runs the hook.
    expect(s.execs).toEqual(['sudo docker ps 2>&1']);
  });

  it('an unknown key fails with MUP text', async () => {
    const s = await setup();
    await expect(runHookCommand(s.ctx, 'meteor.deplyo')).rejects.toThrow('Unknown command name: meteor.deplyo');
  });

  it.each(['meteor.prepareBundle', 'default.ssh', 'docker.destroyCluster', 'proxy.envconfig'])('%s is not supported', async (key) => {
    const s = await setup();
    await expect(runHookCommand(s.ctx, key)).rejects.toThrow(`api.runCommand("${key}") is not supported by comet-deploy.`);
  });

  it('a locking command inside a held lock is refused before it locks', async () => {
    const s = await setup();
    let acquired = 0;
    const deps = {
      acquireLock: async () => (acquired++, { ok: true as const }),
      releaseLock: async () => {},
      readLock: async () => null,
    };
    await lockServers(s.ctx, ['one'], 'deploy', deps);
    await expect(runHookCommand(s.ctx, 'default.restart')).rejects.toThrow(
      'api.runCommand("default.restart") cannot run while comet-deploy holds the deploy lock (from a hook inside a locked step). Run it from a post.default.deploy hook instead.',
    );
    expect(acquired).toBe(1);
  });

  it('every MUP key comet-deploy runs has an entry', () => {
    const expected = MUP_COMMAND_KEYS.filter((k) => !KEYS_COMET_DOES_NOT_RUN.includes(k) && k !== 'meteor.prepareBundle');
    expect(Object.keys(HOOK_COMMANDS).sort()).toEqual([...expected, 'default.rollback'].sort());
  });
});
