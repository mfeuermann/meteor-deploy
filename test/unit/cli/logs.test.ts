import { describe, expect, it } from 'vitest';
import { buildLogsCommand, logsPassthrough, streamLogs } from '../../../src/cli/commands/lifecycle.js';
import type { CommandContext } from '../../../src/core/context.js';
import { createReporter } from '../../../src/output/reporter.js';
import type { ExecOptions, SshConnection } from '../../../src/ssh/connection.js';

describe('buildLogsCommand', () => {
  it('builds the docker logs command like MUP', () => {
    expect(buildLogsCommand('app', ['-f', '--tail', 50])).toBe('sudo docker logs -f --tail 50 app 2>&1');
  });

  it('escapes arguments for the shell', () => {
    expect(buildLogsCommand('app', ['--since', '10m; rm -rf /'])).toBe("sudo docker logs --since '10m; rm -rf /' app 2>&1");
  });
});

describe('logsPassthrough', () => {
  it('rebuilds docker options from argv, without globals and camelCase aliases', () => {
    const argv = { _: ['logs'], f: true, tail: 50, 'show-hook-names': false, showHookNames: false, config: 'x', since: '1h', noColor: false, 'some-opt': 'v', someOpt: 'v', $0: 'comet-deploy' };
    expect(logsPassthrough(argv, ['logs'])).toEqual(['-f', '--tail', 50, '--since', '1h', '--some-opt', 'v']);
  });

  it('keeps extra positionals after the command', () => {
    expect(logsPassthrough({ _: ['meteor', 'logs', 'extra'], $0: 'x' }, ['meteor', 'logs'])).toEqual(['extra']);
  });
});

describe('streamLogs', () => {
  it('prefixes every line with [host] and runs on all servers', async () => {
    const lines: string[] = [];
    const reporter = createReporter({ verbose: false, tty: false, write: (s) => void lines.push(s) });
    const conn = (host: string) =>
      ({
        name: host,
        host,
        async exec(cmd: string, o: ExecOptions) {
          o.onStdout?.(`${cmd}\nline 1\nli`);
          o.onStdout?.('ne 2\n');
          return { code: 0, stdout: '', stderr: '' };
        },
      }) as unknown as SshConnection;
    const ctx = {
      config: { app: { name: 'app' }, servers: { one: { host: '192.0.2.1' }, two: { host: '192.0.2.2' } } },
      reporter,
      appServers: () => ['one', 'two'],
      ssh: { get: async (n: string) => conn(n === 'one' ? '192.0.2.1' : '192.0.2.2') },
    } as unknown as CommandContext;
    await streamLogs(ctx, ['--tail', 2]);
    const text = lines.join('');
    expect(text).toContain('[192.0.2.1]line 1\n');
    expect(text).toContain('[192.0.2.1]line 2\n');
    expect(text).toContain('[192.0.2.2]sudo docker logs --tail 2 app 2>&1\n');
  });
});

describe('logs through the CLI', () => {
  it('passes docker logs options through yargs (top-level and meteor logs)', async () => {
    const { main } = await import('../../../src/cli/main.js');
    const { captureIO, tempDir } = await import('../../helpers/fs.js');
    const dir = tempDir({
      '.deploy/mup.js': `module.exports = { servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw' } }, app: { name: 'myapp', path: '../app', servers: { one: {} }, env: { ROOT_URL: 'http://a.com' } } };`,
    });
    const cmds: string[] = [];
    const sshPoolFactory = () => ({
      get: async () => ({ exec: async (c: string) => (cmds.push(c), { code: 0, stdout: '', stderr: '' }) }) as unknown as SshConnection,
      closeAll: async () => {},
    });
    const io = captureIO();
    expect(await main(['logs', '-f', '--tail', '50', '--config', '.deploy/mup.js'], io.io, { cwd: dir, sshPoolFactory })).toBe(0);
    expect(await main(['meteor', 'logs', '--since', '1h', '-t', '--config', '.deploy/mup.js'], io.io, { cwd: dir, sshPoolFactory })).toBe(0);
    expect(cmds).toEqual(['sudo docker logs -f --tail 50 myapp 2>&1', 'sudo docker logs --since 1h -t myapp 2>&1']);
  });
});
