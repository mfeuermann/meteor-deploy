import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createContext } from '../../../src/core/context.js';
import { mongoShell } from '../../../src/mongo/shell.js';
import { createReporter } from '../../../src/output/reporter.js';
import type { SshConnection } from '../../../src/ssh/connection.js';
import type { LocalTerminal } from '../../../src/ssh/interactive.js';

const fixture = join(import.meta.dirname, '../../fixtures/configs/mongo');

async function run(exitCode = 0) {
  const calls: { server: string; command: string; pty: unknown }[] = [];
  const conn = (name: string) =>
    ({ name, interactive: async (command: string, o: { pty?: unknown }) => (calls.push({ server: name, command, pty: o.pty }), exitCode) }) as unknown as SshConnection;
  const ctx = await createContext(
    { config: join(fixture, 'mup.js') },
    {
      cwd: fixture,
      reporter: createReporter({ verbose: false, tty: false, write: () => {} }),
      sshPoolFactory: () => ({ get: async (n: string) => conn(n), closeAll: async () => {} }),
    },
  );
  const out = Object.assign(new EventEmitter(), { write: () => true });
  const term = { stdin: Object.assign(new PassThrough(), { isTTY: false }), stdout: out, stderr: out } as unknown as LocalTerminal;
  return { calls, done: mongoShell(ctx, term), ctx };
}

describe('mongo shell', () => {
  it('mongo shell runs mongosh on dbName', async () => {
    // The fixture: app "my.mongo.app" (dbName "mymongoapp"), MongoDB 6.0.13 on server "one".
    const r = await run();
    await r.done;
    expect(r.calls).toEqual([{ server: 'one', command: 'sudo docker exec -i mongodb mongosh mymongoapp', pty: undefined }]);
    expect(r.ctx.runner.history).toEqual(['mongo.shell']);
  });

  it("exits with the shell's exit code", async () => {
    const r = await run(5);
    await expect(r.done).rejects.toMatchObject({ exitCode: 5 });
  });
});
