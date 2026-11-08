import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { expandTilde, findConfigFile, loadConfig, loadSettings, resolveUserPath } from '../../../src/config/load.js';
import { CometError } from '../../../src/core/errors.js';

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'comet-load-'));
  for (const [name, content] of Object.entries(files)) {
    const p = join(d, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return d;
}

const JS = (name: string) => `module.exports = { app: { name: '${name}' } };`;

describe('findConfigFile', () => {
  it('prefers mup.js over mup.json', () => {
    const d = dir({ 'mup.js': JS('a'), 'mup.json': '{}' });
    expect(findConfigFile(d)).toBe(join(d, 'mup.js'));
  });

  it('falls back to mup.json', () => {
    const d = dir({ 'mup.json': '{}' });
    expect(findConfigFile(d)).toBe(join(d, 'mup.json'));
  });

  it('throws a CometError mentioning mup.js and init when nothing exists', () => {
    const d = dir({});
    expect(() => findConfigFile(d)).toThrow(CometError);
    try {
      findConfigFile(d);
    } catch (e) {
      const err = e as CometError;
      expect(err.message + (err.hint ?? '')).toContain('mup.js');
      expect(err.message + (err.hint ?? '')).toContain('comet-deploy init');
    }
  });

  it('resolves --config relative to cwd', () => {
    const d = dir({ 'x/custom.json': '{"app":{"name":"c"}}' });
    expect(findConfigFile(d, './x/custom.json')).toBe(join(d, 'x/custom.json'));
  });
});

describe('loadConfig', () => {
  it('uses the config dir as basePath with --config, cwd otherwise', () => {
    const d = dir({ 'x/custom.json': '{"app":{"name":"c"}}', 'mup.js': JS('root') });
    const withFlag = loadConfig(d, './x/custom.json');
    expect(withFlag.basePath).toBe(join(d, 'x'));
    expect(withFlag.raw.app.name).toBe('c');
    const noFlag = loadConfig(d);
    expect(noFlag.basePath).toBe(d);
    expect(noFlag.raw.app.name).toBe('root');
  });

  it('reloads a .js config freshly after it changes', () => {
    const d = dir({ 'mup.js': JS('first') });
    expect(loadConfig(d).raw.app.name).toBe('first');
    writeFileSync(join(d, 'mup.js'), JS('second'));
    expect(loadConfig(d).raw.app.name).toBe('second');
  });

  it('reports invalid JSON with the file name', () => {
    const d = dir({ 'mup.json': '{ "app": ' });
    expect(() => loadConfig(d)).toThrow(/mup\.json/);
    expect(() => loadConfig(d)).toThrow(CometError);
  });
});

describe('loadSettings', () => {
  it('reads <basePath>/settings.json by default', () => {
    const d = dir({ 'settings.json': '{"public":{"a":1}}' });
    const r = loadSettings({ cwd: '/', basePath: d });
    expect(r.settings).toEqual({ public: { a: 1 } });
    expect(r.settingsPath).toBe(join(d, 'settings.json'));
  });

  it('resolves --settings relative to cwd', () => {
    const d = dir({ 'conf/prod.json': '{"x":true}' });
    expect(loadSettings({ cwd: d, basePath: '/nowhere', settingsFlag: 'conf/prod.json' }).settings).toEqual({ x: true });
  });

  it('fails with the path when missing', () => {
    const d = dir({});
    expect(() => loadSettings({ cwd: d, basePath: d })).toThrow(join(d, 'settings.json'));
  });

  it('fails on invalid JSON', () => {
    const d = dir({ 'settings.json': '{nope' });
    expect(() => loadSettings({ cwd: d, basePath: d })).toThrow(CometError);
  });
});

describe('resolveUserPath', () => {
  it('falls back to basePath with a warning when missing relative to cwd', () => {
    const base = dir({ 'k.pem': 'KEY' });
    const cwd = dir({});
    const warn = vi.fn();
    expect(resolveUserPath('k.pem', { cwd, basePath: base, base: 'cwd', warn })).toBe(join(base, 'k.pem'));
    expect(warn).toHaveBeenCalledOnce();
  });

  it('keeps the cwd path when it exists', () => {
    const cwd = dir({ 'k.pem': 'KEY' });
    const warn = vi.fn();
    expect(resolveUserPath('k.pem', { cwd, basePath: '/x', base: 'cwd', warn })).toBe(join(cwd, 'k.pem'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('resolves config-relative paths against basePath', () => {
    expect(resolveUserPath('../app', { cwd: '/c', basePath: '/b/.deploy', base: 'config' })).toBe('/b/app');
  });

  it('expands ~', () => {
    expect(expandTilde('~/x')).not.toContain('~');
    expect(resolveUserPath('/abs/p', { cwd: '/c', basePath: '/b', base: 'cwd' })).toBe('/abs/p');
  });
});
