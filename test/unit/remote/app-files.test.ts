import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadSettingsFile } from '../../../src/config/load.js';
import { normalizeConfig } from '../../../src/config/normalize.js';
import type { NormalizedConfig } from '../../../src/config/types.js';
import { CometError } from '../../../src/core/errors.js';
import {
  renderEnvList,
  renderMeteorDestroy,
  renderMeteorSetup,
  renderMeteorStart,
  renderMeteorStop,
  renderStartSh,
} from '../../../src/remote/app-files.js';
import { renderTemplate, templatePath } from '../../../src/remote/render.js';
import { mupEnvconfigFiles } from '../../oracle/mup-oracle.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../../fixtures/configs');
const require = createRequire(import.meta.url);
const mupMeteorAssets = join(dirname(require.resolve('mup/package.json')), 'lib/plugins/meteor/assets');
const ejs = require('@zodern/ejs');

function load(name: string): { config: NormalizedConfig; dir: string; settingsPath: string; settings: unknown } {
  const dir = join(fixtures, name);
  const { raw, basePath } = loadConfig(dir, './mup.js');
  const settingsPath = join(dir, 'settings.json');
  return { config: normalizeConfig(raw, { basePath }), dir, settingsPath, settings: loadSettingsFile(settingsPath) };
}

// Deliberate fix (spec §7 quirk table): with proxy.ssl MUP drops the port colon from ROOT_URL.
const fixKnownMupQuirks = (s: string) => s.replace('ROOT_URL=https://a.com3000\n', 'ROOT_URL=https://a.com:3000\n');

const FIXTURES = ['aaa-like', 'per-server-env', 'mongo', 'proxy-le', 'proxy-lb', 'registry'];

describe('start.sh / env.list are byte-identical with MUP envconfig', () => {
  for (const name of FIXTURES) {
    const { config } = load(name);
    for (const server of Object.keys(config.app.servers)) {
      it(`${name} / ${server}`, async () => {
        const { config: c, dir, settingsPath, settings } = load(name);
        const expected = await mupEnvconfigFiles(join(dir, 'mup.js'), settingsPath, server);
        expect(await renderStartSh(c, server)).toBe(expected.startSh);
        expect(await renderEnvList(c, settings, server, { cwd: dir, basePath: dir })).toBe(fixKnownMupQuirks(expected.envList));
      });
    }
  }

  it('per-server PORT goes to start.sh only, never into env.list', async () => {
    const { config, dir, settings } = load('per-server-env');
    expect(await renderStartSh(config, 'one')).toContain('PORT=4000\n');
    const envList = await renderEnvList(config, settings, 'one', { cwd: dir, basePath: dir });
    expect(envList).toContain('  PORT=3001\n');
    expect(envList).not.toContain('PORT=4000');
  });

  it('per-server values do not leak into another server (MUP shares vars across hosts)', async () => {
    const { config, dir, settings } = load('per-server-env');
    const two = await renderStartSh(config, 'two');
    expect(two).toContain('BIND=0.0.0.0\n');
    expect(two).toContain('PORT=80\n');
    const envTwo = await renderEnvList(config, settings, 'two', { cwd: dir, basePath: dir });
    expect(envTwo).not.toContain('ROLE=');
    expect(envTwo).not.toContain('EXTRA=');
  });
});

describe('METEOR_SETTINGS with special characters (Review Focus 1)', () => {
  it('is written verbatim as JSON.stringify(settings), no shell expansion or escaping', async () => {
    const config = normalizeConfig(
      {
        servers: { one: { host: '192.0.2.1', username: 'root' } },
        app: { name: 'x', path: '/srv/x', servers: { one: {} }, env: { ROOT_URL: 'http://x.example.com' } },
      },
      { basePath: '/srv' },
    );
    const settings = { a: 'x$HOME "q" ü', b: 'y'.repeat(40 * 1024) };
    const out = await renderEnvList(config, settings, 'one', { cwd: '/srv', basePath: '/srv' });
    const lines = out.split('\n');
    expect(lines).toContain('  METEOR_SETTINGS=' + JSON.stringify(settings));
    expect(out).toContain('x$HOME \\"q\\" ü');
  });
});

describe('env.list line limit (M11)', () => {
  const config = normalizeConfig(
    {
      servers: { one: { host: '192.0.2.1', username: 'root' } },
      app: { name: 'x', path: '/srv/x', servers: { one: {} }, env: { ROOT_URL: 'http://x.example.com' } },
    },
    { basePath: '/srv' },
  );
  const o = { cwd: '/srv', basePath: '/srv' };

  it('refuses METEOR_SETTINGS that Docker cannot read (lines of 64 KiB and more)', async () => {
    const err = await renderEnvList(config, { b: 'y'.repeat(64 * 1024) }, 'one', o).catch((e) => e);
    expect(err).toBeInstanceOf(CometError);
    expect(err.message).toMatch(/METEOR_SETTINGS/);
    expect(err.message).toMatch(/64 KiB/);
    expect(err.message).toMatch(/"one"/);
  });

  it('accepts a line just below the limit, counted in bytes', async () => {
    const prefix = '  METEOR_SETTINGS='.length + JSON.stringify({ b: '' }).length;
    await expect(renderEnvList(config, { b: 'y'.repeat(65535 - prefix) }, 'one', o)).resolves.toContain('METEOR_SETTINGS=');
    await expect(renderEnvList(config, { b: 'ü'.repeat(Math.ceil((65536 - prefix) / 2)) }, 'one', o)).rejects.toThrow(/64 KiB/);
  });
});

describe('meteor-*.sh scripts render like MUP', () => {
  const mup = (file: string, vars: Record<string, unknown>) => {
    const path = join(mupMeteorAssets, file);
    return ejs.render(readFileSync(path, 'utf8'), vars, { filename: path });
  };

  it('meteor-start.sh with and without a registry / removeImage', async () => {
    const { config } = load('aaa-like');
    expect(await renderMeteorStart(config)).toBe(mup('meteor-start.sh', { appName: config.app.name, removeImage: false, privateRegistry: undefined }));
    expect(await renderMeteorStart(config, { removeImage: true })).toContain('sudo docker rmi $IMAGE:latest || true');
    const reg = load('registry').config;
    expect(await renderMeteorStart(reg)).toBe(
      mup('meteor-start.sh', { appName: reg.app.name, removeImage: false, privateRegistry: reg.privateDockerRegistry }),
    );
  });

  it('meteor-stop.sh, meteor-setup.sh, meteor-destroy.sh', async () => {
    const { config } = load('upper-dot-name');
    expect(await renderMeteorStop(config)).toBe(mup('meteor-stop.sh', { appName: config.app.name }));
    expect(await renderMeteorSetup(config)).toBe(mup('meteor-setup.sh', { name: config.app.name }));
    expect(await renderMeteorDestroy(config)).toBe(mup('meteor-destroy.sh', { name: config.app.name }));
  });
});

describe('renderTemplate', () => {
  it('resolves templates inside the package and supports ejs include', async () => {
    expect(templatePath('mup/docker/docker-setup.sh')).toMatch(/templates\/mup\/docker\/docker-setup\.sh$/);
    const out = await renderTemplate('mup/docker/docker-setup.sh', { privateRegistry: undefined });
    const installDocker = readFileSync(templatePath('mup/docker/install-docker.sh'), 'utf8');
    expect(out).toContain(installDocker.split('\n').find((l) => l.trim().length > 20));
    expect(out).not.toContain('<% include');
  });
});
