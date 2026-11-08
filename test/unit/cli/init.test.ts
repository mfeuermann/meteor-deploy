import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/main.js';
import { templatePath } from '../../../src/remote/render.js';
import { captureIO, tempDir } from '../../helpers/fs.js';

const SAMPLE = readFileSync(templatePath('mup/default/mup.js.sample'), 'utf8');
const SETTINGS = readFileSync(templatePath('mup/default/settings.json'), 'utf8');

function evalSample(appPath: string): unknown {
  const module = { exports: {} as unknown };
  new Function('module', 'exports', SAMPLE.replace('<app path>', appPath))(module, module.exports);
  return module.exports;
}

describe('init', () => {
  it('creates .deploy/mup.js and settings.json inside a Meteor app', async () => {
    const app = tempDir({ '.meteor/release': 'METEOR@3.0' });
    const c = captureIO();
    expect(await main(['init'], c.io, { cwd: app })).toBe(0);
    expect(readFileSync(join(app, '.deploy/mup.js'), 'utf8')).toBe(SAMPLE.replace('<app path>', '../'));
    expect(readFileSync(join(app, '.deploy/settings.json'), 'utf8')).toBe(SETTINGS);
    expect(c.stdout()).toMatch(/Created .*mup\.js/);
  });

  it('--json writes an equivalent mup.json', async () => {
    const app = tempDir({ '.meteor/release': 'METEOR@3.0' });
    expect(await main(['init', '--json'], captureIO().io, { cwd: app })).toBe(0);
    expect(existsSync(join(app, '.deploy/mup.js'))).toBe(false);
    expect(JSON.parse(readFileSync(join(app, '.deploy/mup.json'), 'utf8'))).toEqual(evalSample('../'));
  });

  it('never overwrites existing files', async () => {
    const app = tempDir({ '.meteor/release': 'METEOR@3.0', '.deploy/mup.js': 'KEEP', '.deploy/settings.json': '{"keep":1}' });
    const c = captureIO();
    expect(await main(['init'], c.io, { cwd: app })).toBe(0);
    expect(readFileSync(join(app, '.deploy/mup.js'), 'utf8')).toBe('KEEP');
    expect(readFileSync(join(app, '.deploy/settings.json'), 'utf8')).toBe('{"keep":1}');
    expect(c.stdout()).toMatch(/mup\.js already exists/);
    expect(c.stdout()).toMatch(/settings\.json already exists/);
  });

  it('uses ../ when the parent is a Meteor app', async () => {
    const root = tempDir({ '.meteor/release': 'METEOR@3.0' });
    const cwd = join(root, 'deploy');
    mkdirSync(cwd);
    expect(await main(['init'], captureIO().io, { cwd })).toBe(0);
    expect(readFileSync(join(cwd, 'mup.js'), 'utf8')).toContain("path: '../',");
  });

  it('uses ../<sibling> when the only sibling is a Meteor app', async () => {
    const root = tempDir({ 'app/.meteor/release': 'METEOR@3.0' });
    const cwd = join(root, 'deploy');
    mkdirSync(cwd);
    expect(await main(['init'], captureIO().io, { cwd })).toBe(0);
    expect(readFileSync(join(cwd, 'mup.js'), 'utf8')).toContain("path: '../app',");
  });

  it('writes into cwd with ./ otherwise', async () => {
    const root = tempDir({ 'a/x': '', 'b/y': '' });
    const cwd = join(root, 'a');
    writeFileSync(join(root, 'c'), '');
    expect(await main(['init'], captureIO().io, { cwd })).toBe(0);
    expect(readFileSync(join(cwd, 'mup.js'), 'utf8')).toContain("path: './',");
  });
});
