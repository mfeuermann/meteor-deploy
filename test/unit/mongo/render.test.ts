import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { normalizeConfig } from '../../../src/config/normalize.js';
import { MONGO_CONTAINER, MONGO_START_NEW, mongoServers, mongoShellCommand, renderMongoAsset, renderMongoStartScript } from '../../../src/mongo/render.js';
import { templatePath } from '../../../src/remote/render.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const mupAssets = join(dirname(require.resolve('mup/package.json')), 'lib/plugins/mongo/assets');
const ejs = require('@zodern/ejs');

/** MUP's own rendering of templates/start.sh (lib/plugins/mongo/command-handlers.js `setup`). */
function mupStartSh(mongo: { version: string; dataPath?: string }): string {
  const path = join(mupAssets, 'templates/start.sh');
  const vars = {
    mongoVersion: mongo.version,
    mongoshCmd: (mongo.version.split('.')[0] as unknown as number) > 5 ? 'mongosh' : 'mongo',
    mongoDbDir: mongo.dataPath || '/var/lib/mongodb',
  };
  return ejs.render(readFileSync(path, 'utf8'), vars, { filename: path });
}

describe('MUP mongo templates', () => {
  it('the copied assets are byte-identical with MUP 1.5.11', () => {
    for (const f of ['mongo-setup.sh', 'mongo-start.sh', 'mongo-stop.sh', 'templates/start.sh']) {
      expect(readFileSync(templatePath(`mup/mongo/${f}`)).equals(readFileSync(join(mupAssets, f))), f).toBe(true);
    }
  });

  for (const mongo of [{ version: '3.4.24' }, { version: '5.0.31' }, { version: '6.0.13' }, { version: '7.0.14', dataPath: '/srv/mongo' }]) {
    it(`renders start.sh like MUP for ${JSON.stringify(mongo)}`, async () => {
      expect(await renderMongoStartScript(mongo)).toBe(mupStartSh(mongo));
    });
  }

  it('renders the plain scripts unchanged', async () => {
    expect(await renderMongoAsset('mongo-stop.sh')).toBe(readFileSync(join(mupAssets, 'mongo-stop.sh'), 'utf8'));
    expect(await renderMongoAsset('mongo-start.sh')).toBe(readFileSync(join(mupAssets, 'mongo-start.sh'), 'utf8'));
  });

  it('uses the names MUP uses on the server', () => {
    expect(MONGO_CONTAINER).toBe('mongodb');
    expect(MONGO_START_NEW).toBe('/opt/mongodb/mongo-start-new.sh');
  });
});

describe('mongoShellCommand', () => {
  it('picks mongosh above major version 5, like MUP', () => {
    expect(mongoShellCommand('3.4.24')).toBe('mongo');
    expect(mongoShellCommand('5.0.31')).toBe('mongo');
    expect(mongoShellCommand('6.0.13')).toBe('mongosh');
    expect(mongoShellCommand('10.0.0')).toBe('mongosh');
    expect(mongoShellCommand('latest')).toBe('mongo');
  });
});

describe('mongoServers', () => {
  const load = () => {
    const dir = join(here, '../../fixtures/configs/mongo');
    const { raw, basePath } = loadConfig(dir, './mup.js');
    return normalizeConfig(raw, { basePath });
  };

  it('lists mongo.servers and respects --servers', () => {
    const c = load();
    c.mongo!.servers = { one: {}, two: {} };
    expect(mongoServers(c, null)).toEqual(['one', 'two']);
    expect(mongoServers(c, ['two'])).toEqual(['two']);
  });

  it('is empty without a mongo section', () => {
    const c = load();
    delete c.mongo;
    expect(mongoServers(c, null)).toEqual([]);
  });
});
