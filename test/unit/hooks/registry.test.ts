import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookIssues, hookTable, MUP_COMMAND_KEYS, normalizeHookName } from '../../../src/hooks/registry.js';

describe('hook names', () => {
  it('normalizes a name with one dot to the default plugin', () => {
    expect(normalizeHookName('pre.deploy')).toBe('pre.default.deploy');
    expect(normalizeHookName('post.setup')).toBe('post.default.setup');
    expect(normalizeHookName('post.meteor.start')).toBe('post.meteor.start');
    expect(normalizeHookName('pre.default.deploy')).toBe('pre.default.deploy');
  });

  it('merges handlers under one name in Object.keys order', () => {
    const a = { localCommand: 'a' };
    const b = { remoteCommand: 'b' };
    const fn = () => {};
    const t = hookTable({ 'pre.deploy': a, 'pre.default.deploy': b, 'post.meteor.start': fn });
    expect(t.get('pre.default.deploy')).toEqual([a, b]);
    expect(t.get('post.meteor.start')).toEqual([{ method: fn }]);
    expect(hookTable(undefined).size).toBe(0);
  });
});

describe('MUP_COMMAND_KEYS', () => {
  it('matches MUP 1.5.11', () => {
    const require = createRequire(import.meta.url);
    const lib = join(dirname(require.resolve('mup/package.json')), 'lib', 'plugins');
    const keys = new Set<string>();
    for (const plugin of ['default', 'docker', 'meteor', 'mongo', 'proxy']) {
      const src = readFileSync(join(lib, plugin, 'commands.js'), 'utf8');
      for (const m of src.matchAll(/^const (\w+) = exports\.\w+ = \{/gm)) keys.add(`${plugin}.${m[1]}`);
    }
    expect(keys.size).toBe(45);
    expect(new Set(MUP_COMMAND_KEYS)).toEqual(keys);
  });
});

describe('hookIssues', () => {
  const issue = (hooks: unknown) => hookIssues(hooks);

  it('a value that is neither an object nor a function is an error', () => {
    expect(issue({ 'pre.deploy': 'x' })).toEqual([
      { path: 'hooks."pre.deploy"', message: 'must be an object with localCommand, remoteCommand or method, or a function', severity: 'error' },
    ]);
  });

  it('wrong types of the three forms are errors', () => {
    expect(issue({ 'pre.deploy': { localCommand: 1 } })).toEqual([{ path: 'hooks."pre.deploy".localCommand', message: 'must be a string', severity: 'error' }]);
    expect(issue({ 'pre.deploy': { remoteCommand: true } })).toEqual([{ path: 'hooks."pre.deploy".remoteCommand', message: 'must be a string', severity: 'error' }]);
    expect(issue({ 'pre.deploy': { method: 'x' } })).toEqual([{ path: 'hooks."pre.deploy".method', message: 'must be a function', severity: 'error' }]);
  });

  it('an unknown property inside a hook is a warning', () => {
    expect(issue({ 'pre.deploy': { localCommand: 'a', foo: 1 } })).toEqual([{ path: 'hooks."pre.deploy".foo', message: 'is an unknown property', severity: 'warning' }]);
  });

  it('a name without pre. or post. is a warning', () => {
    expect(issue({ deploy: { localCommand: 'a' } })).toEqual([{ path: 'hooks."deploy"', message: 'must start with "pre." or "post."', severity: 'warning' }]);
  });

  it('a name that matches no command is a warning', () => {
    expect(issue({ 'pre.deplyo': { localCommand: 'a' } })).toEqual([{ path: 'hooks."pre.deplyo"', message: 'does not match a command, so it never runs', severity: 'warning' }]);
  });

  it('a hook on a command comet-deploy does not run is a warning', () => {
    expect(issue({ 'pre.ssh': () => {} })).toEqual([
      { path: 'hooks."pre.ssh"', message: 'belongs to a command comet-deploy does not run (default.ssh), so it never runs', severity: 'warning' },
    ]);
  });

  it('accepts the hooks of MUP and comet-deploy keys', () => {
    expect(issue({ 'pre.rollback': { localCommand: 'a' }, 'post.proxy.reconfigShared': { method: () => {} }, 'post.meteor.prepareBundle': { remoteCommand: 'b' } })).toEqual([]);
    expect(issue(undefined)).toEqual([]);
  });

  it('a hooks section that is not an object is an error', () => {
    expect(issue('x')).toEqual([{ path: 'hooks', message: 'must be an object', severity: 'error' }]);
  });
});
