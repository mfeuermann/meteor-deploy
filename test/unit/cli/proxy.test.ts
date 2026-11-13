import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROXY_COMMANDS } from '../../../src/cli/commands/proxy.js';
import { statusCommand } from '../../../src/cli/commands/status.js';
import type { ConfigCommand } from '../../../src/cli/registry.js';
import { main } from '../../../src/cli/main.js';
import { createContext } from '../../../src/core/context.js';
import { createReporter } from '../../../src/output/reporter.js';
import type { ExecResult, SshConnection } from '../../../src/ssh/connection.js';
import { captureIO } from '../../helpers/fs.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../../fixtures/configs');

describe('proxy commands', () => {
  it('"proxy envconfig" fails like in MUP 1.5.11, with a clear message', async () => {
    const io = captureIO();
    expect(await main(['proxy', 'envconfig'], io.io, { cwd: process.cwd() })).toBe(1);
    expect(io.stderr()).toContain('"proxy envconfig" has no implementation in MUP 1.5.11 either: it is listed in its help, but running it fails.');
  });

  it('"proxy --help" lists all nine proxy commands', async () => {
    const io = captureIO();
    expect(await main(['proxy', '--help'], io.io, { cwd: process.cwd() })).toBe(0);
    const help = io.stdout();
    for (const name of ['setup', 'start', 'stop', 'reconfig-shared', 'logs', 'logs-le', 'nginx-config', 'status', 'envconfig']) {
      expect(help, name).toMatch(new RegExp(`comet-deploy proxy ${name}\\b`));
    }
    // yargs wraps the description to the terminal width.
    expect(help.replace(/\s+/g, ' ')).toMatch(/Configure environment variables for proxy \(not implemented in MUP 1\.5\.11 ?\)/);
  });

  it('"status" shows the proxy status after the app table (MUP post.default.status)', async () => {
    const dir = join(fixtures, 'proxy-certs');
    const out: string[] = [];
    const run = async (s: string): Promise<ExecResult> => ({ code: 0, stdout: s.includes('nginx=') ? 'nginx=running\nle=running\nhttp=80\nhttps=443\n' : 'docker=27.5.1\ncontainer=running\n', stderr: '' });
    const conn = (name: string) => ({ name, host: name, runScript: run, runScriptOrThrow: run, exec: run }) as unknown as SshConnection;
    const ctx = await createContext(
      { config: join(dir, 'mup.js') },
      {
        cwd: dir,
        reporter: createReporter({ verbose: false, tty: false, write: (s) => void out.push(s) }),
        sshPoolFactory: () => ({ get: async (n: string) => conn(n), closeAll: async () => {} }),
      },
    );
    await statusCommand.run(ctx, {});
    expect(ctx.runner.history).toEqual(['default.status', 'docker.status', 'meteor.status', 'proxy.status']);
    const command = (name: string) => PROXY_COMMANDS.find((c) => c.command === name)! as ConfigCommand;
    await command('logs-le').run(ctx, { _: ['proxy', 'logs-le'] });
    await command('nginx-config').run(ctx, { _: ['proxy', 'nginx-config'] });
    // MUP's keys are the export names, not the CLI names.
    expect(ctx.runner.history.slice(4)).toEqual(['proxy.leLogs', 'proxy.nginxConfig']);
    const text = out.join('');
    expect(text.indexOf('SERVER')).toBeLessThan(text.indexOf('=> Reverse Proxy Status'));
  });
});
