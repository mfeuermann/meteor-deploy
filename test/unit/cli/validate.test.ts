import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/main.js';
import { captureIO, tempDir } from '../../helpers/fs.js';

const here = dirname(fileURLToPath(import.meta.url));
const aaaLike = join(here, '../../fixtures/configs/aaa-like');

const INVALID = `module.exports = { servers: { one: { host: '192.0.2.1', username: 'u' } }, app: { path: '/x', servers: { one: {} }, env: { ROOT_URL: 'ftp://a.com' } } };`;

function json(text: string): any {
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

describe('validate', () => {
  it('prints every problem and exits 1 for an invalid config', async () => {
    const c = captureIO();
    const code = await main(['validate'], c.io, { cwd: tempDir({ 'mup.js': INVALID }) });
    expect(code).toBe(1);
    expect(c.all()).toMatch(/app\.name/);
    expect(c.all()).toMatch(/app\.env\.ROOT_URL/);
  });

  it('exits 1 for warnings too (like MUP)', async () => {
    const c = captureIO();
    const cfg = `module.exports = { servers: { one: { host: 'h', username: 'u' } }, app: { name: 'a', path: '/x', servers: { one: {} }, env: { ROOT_URL: 'http://a.com' } }, foo: 1 };`;
    expect(await main(['validate'], c.io, { cwd: tempDir({ 'mup.js': cfg }) })).toBe(1);
    expect(c.all()).toMatch(/foo is an unknown property/);
  });

  it('reports a valid config with exit 0', async () => {
    const c = captureIO();
    expect(await main(['validate'], c.io, { cwd: aaaLike })).toBe(0);
    expect(c.stdout()).toMatch(/Config is valid/);
  });

  it('--show prints the normalized config as JSON', async () => {
    const c = captureIO();
    expect(await main(['validate', '--show'], c.io, { cwd: aaaLike })).toBe(0);
    const cfg = json(c.stdout());
    expect(cfg.app.type).toBe('meteor');
    expect(cfg.app.docker.image).toBe('zodern/meteor:latest');
    expect(cfg.servers.one.password).toBe('example-pass-1');
  });

  it('--scrub prints the scrubbed config', async () => {
    const c = captureIO();
    expect(await main(['validate', '--scrub'], c.io, { cwd: aaaLike })).toBe(0);
    const cfg = json(c.stdout());
    expect(cfg.servers.one.host).toBe('1.2.3.4');
    expect(cfg.servers.one.password).toBe('password');
    expect(c.stdout()).not.toContain('example-pass-1');
  });

  it('--show still prints the config before failing on problems', async () => {
    const c = captureIO();
    expect(await main(['validate', '--show'], c.io, { cwd: tempDir({ 'mup.js': INVALID }) })).toBe(1);
    expect(json(c.stdout()).app.path).toBe('/x');
  });
});
