import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { describe, expect, it, vi } from 'vitest';
import { registerCommands, type CommandModule } from '../../../src/cli/registry.js';
import { createContext } from '../../../src/core/context.js';
import { CometError } from '../../../src/core/errors.js';
import { CommandRunner } from '../../../src/core/runner.js';
import { createReporter } from '../../../src/output/reporter.js';
import { tempDir } from '../../helpers/fs.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../../fixtures/configs');

function reporter() {
  const lines: string[] = [];
  return { r: createReporter({ verbose: false, tty: false, write: (s) => void lines.push(s) }), text: () => lines.join('') };
}

const noSsh = () => ({ get: async () => { throw new Error('no ssh in tests'); }, closeAll: async () => {} });

describe('CommandRunner', () => {
  it('returns the result and records the command key', async () => {
    const runner = new CommandRunner();
    await expect(runner.run('meteor.push', async () => 42)).resolves.toBe(42);
    expect(runner.history).toEqual(['meteor.push']);
  });
});

describe('createContext', () => {
  it('loads and normalizes the config', async () => {
    const { r } = reporter();
    const dir = join(fixtures, 'aaa-like');
    const ctx = await createContext({ config: './mup.js' }, { cwd: dir, reporter: r, sshPoolFactory: noSsh });
    expect(ctx.config.app.name).toBe('example-app');
    expect(ctx.config.app.type).toBe('meteor');
    expect(ctx.basePath).toBe(dir);
    expect(ctx.appServers()).toEqual(['one', 'two']);
  });

  it('throws a CometError listing fatal issues', async () => {
    const d = tempDir({
      'mup.js': `module.exports = { servers: { one: { host: 'h', username: 'u' } }, app: { path: '/x', servers: { one: {} }, env: { ROOT_URL: 'http://a.com' } } };`,
    });
    const { r } = reporter();
    await expect(createContext({}, { cwd: d, reporter: r, sshPoolFactory: noSsh })).rejects.toThrow(CometError);
    await expect(createContext({}, { cwd: d, reporter: r, sshPoolFactory: noSsh })).rejects.toThrow(/app\.name/);
  });

  it('prints warnings and continues', async () => {
    const d = tempDir({
      'mup.js': `module.exports = { servers: { one: { host: 'h', username: 'u' } }, app: { name: 'a', path: '/x', servers: { one: {} }, env: { ROOT_URL: 'http://a.com' } }, foo: 1 };`,
    });
    const { r, text } = reporter();
    const ctx = await createContext({}, { cwd: d, reporter: r, sshPoolFactory: noSsh });
    expect(ctx.config.app.name).toBe('a');
    expect(text()).toMatch(/Warning: foo is an unknown property/);
  });

  it('masks config secrets, and settings values once settings are loaded', async () => {
    const { r, text } = reporter();
    const dir = join(fixtures, 'aaa-like');
    const ctx = await createContext({}, { cwd: dir, reporter: r, sshPoolFactory: noSsh });
    r.info('url mongodb://user:secret@192.0.2.50:27017/example pass example-pass-1');
    r.info('before example-token-123');
    const settings = ctx.getSettings() as any;
    expect(ctx.getSettings()).toBe(settings);
    r.info('after example-token-123');
    expect(text()).toContain('url *** pass ***');
    expect(text()).toContain('before example-token-123');
    expect(text()).toContain('after ***');
  });

  it('rejects an unknown --servers name and filters app servers', async () => {
    const { r } = reporter();
    const dir = join(fixtures, 'aaa-like');
    const ctx = await createContext({ servers: 'two' }, { cwd: dir, reporter: r, sshPoolFactory: noSsh });
    expect(ctx.serverFilter).toEqual(['two']);
    expect(ctx.appServers()).toEqual(['two']);
    await expect(createContext({ servers: 'nope' }, { cwd: dir, reporter: r, sshPoolFactory: noSsh })).rejects.toThrow(/nope/);
  });
});

describe('registerCommands', () => {
  const run = vi.fn(async () => {});
  const mods: CommandModule[] = [
    { command: 'hello', describe: 'top', needsConfig: false, run },
    { command: 'logs', describe: 'logs', strict: false, needsConfig: false, run },
    { command: 'push', describe: 'push', group: 'meteor', needsConfig: false, run },
  ];
  const makeCtx = vi.fn(async () => ({ cwd: '/', verbose: false, argv: {}, reporter: reporter().r, print: () => {} }));
  const cli = (argv: string[]) =>
    registerCommands(yargs(argv).strict().exitProcess(false).fail((m, e) => { throw e ?? new Error(m); }), mods, makeCtx as any).parseAsync();

  it('runs top-level and grouped commands', async () => {
    await cli(['hello']);
    await cli(['meteor', 'push']);
    expect(run).toHaveBeenCalledTimes(2);
    expect(makeCtx).toHaveBeenLastCalledWith(expect.objectContaining({ _: ['meteor', 'push'] }), false);
  });

  it('passes unknown options through for non-strict commands', async () => {
    run.mockClear();
    await cli(['logs', '-f', '--tail', '50']);
    const argv = (run.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(argv.f).toBe(true);
    expect(argv.tail).toBe(50);
  });

  it('rejects unknown options for strict commands', async () => {
    // yargs may throw synchronously from parseAsync for validation failures.
    await expect(Promise.resolve().then(() => cli(['hello', '--nope']))).rejects.toThrow(/nope/i);
  });
});
