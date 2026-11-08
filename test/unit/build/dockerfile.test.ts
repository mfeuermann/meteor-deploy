import { cpSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { argKeysForInstructions, computeDepsHash, detectDepsFiles, planBuildContext, renderDockerfile } from '../../../src/build/dockerfile.js';
import { tempDir } from '../../helpers/fs.js';

const bundle = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/bundles/meteor3/bundle');
const DEPS = ['npm', 'npm-rebuild-args.js', 'npm-rebuild.js', 'npm-rebuilds.json', 'npm-shrinkwrap.json', 'package.json'];

function copyBundle(): string {
  const d = tempDir();
  cpSync(bundle, join(d, 'bundle'), { recursive: true });
  return join(d, 'bundle');
}

describe('detectDepsFiles', () => {
  it('finds manifests, npm/ and the files npm-rebuild requires', () => {
    expect(detectDepsFiles(join(bundle, 'programs/server'))).toEqual(DEPS);
  });

  it('lists only files that exist', () => {
    const b = copyBundle();
    rmSync(join(b, 'programs/server/npm-shrinkwrap.json'));
    expect(detectDepsFiles(join(b, 'programs/server'))).not.toContain('npm-shrinkwrap.json');
  });
});

describe('planBuildContext', () => {
  const plan = planBuildContext(bundle);

  it('puts the deps into their own copy list', () => {
    expect(plan.depsCopy).toEqual(DEPS.map((f) => `bundle/programs/server/${f}`));
  });

  it('copies everything else without npm/ or deps files', () => {
    const froms = plan.appCopy.map((c) => c.from);
    for (const f of froms) expect(f.startsWith('bundle/programs/server/npm')).toBe(false);
    expect(froms).not.toContain('bundle/programs/server/package.json');
    expect(froms).not.toContain('bundle/programs/server/npm-shrinkwrap.json');
    expect(froms).not.toContain('bundle/programs');
    expect(froms).not.toContain('bundle/programs/server');
    for (const f of ['bundle/main.js', 'bundle/README', 'bundle/star.json', 'bundle/server', 'bundle/programs/web.browser', 'bundle/programs/web.browser.legacy', 'bundle/programs/server/boot.js', 'bundle/programs/server/packages', 'bundle/programs/server/app']) {
      expect(froms).toContain(f);
    }
    expect(plan.appCopy.find((c) => c.from === 'bundle/programs/server/boot.js')!.to).toBe('/built_app/programs/server/boot.js');
    expect(plan.appCopy.find((c) => c.from === 'bundle/main.js')!.to).toBe('/built_app/main.js');
  });
});

describe('renderDockerfile', () => {
  const plan = planBuildContext(bundle);

  it('orders base, instructions, deps layer, npm install, then the app', () => {
    const df = renderDockerfile({ baseImage: 'zodern/meteor:latest', buildInstructions: ['RUN apt-get install -y x'], argKeys: ['FOO'], plan, chownApp: true });
    const lines = df.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    expect(lines[0]).toBe('FROM zodern/meteor:latest');
    expect(lines[1]).toBe('RUN mkdir /built_app || true');
    expect(lines[2]).toBe('ARG FOO');
    expect(lines[3]).toBe('RUN apt-get install -y x');
    const depFiles = DEPS.filter((f) => f !== 'npm').map((f) => `bundle/programs/server/${f}`);
    expect(lines[4]).toBe(`COPY --chown=app:app ${depFiles.join(' ')} /built_app/programs/server/`);
    expect(lines[5]).toBe('COPY --chown=app:app bundle/programs/server/npm /built_app/programs/server/npm');
    expect(lines[6]).toBe('RUN cd /built_app/programs/server && npm install --unsafe-perm');
    const rest = lines.slice(7);
    expect(rest).toEqual(plan.appCopy.map((c) => `COPY --chown=app:app ${c.from} ${c.to}`));
  });

  it('omits --chown when not requested and never contains env values', () => {
    const df = renderDockerfile({ baseImage: 'abernix/meteord:node-12-base', buildInstructions: [], argKeys: [], plan, chownApp: false });
    expect(df).not.toContain('--chown');
    expect(df).not.toMatch(/^ARG /m);
  });
});

describe('argKeysForInstructions', () => {
  it('returns referenced env keys, sorted', () => {
    expect(argKeysForInstructions(['RUN echo $FOO ${BAR}'], ['FOO', 'BAR', 'BAZ'])).toEqual(['BAR', 'FOO']);
    expect(argKeysForInstructions(['RUN echo $FOOD'], ['FOO'])).toEqual([]);
    expect(argKeysForInstructions([], ['FOO'])).toEqual([]);
  });
});

describe('computeDepsHash', () => {
  it('ignores mtime and changes with dependency content', async () => {
    const a = copyBundle();
    const b = copyBundle();
    utimesSync(join(b, 'programs/server/package.json'), new Date(2001, 1, 1), new Date(2001, 1, 1));
    const ha = await computeDepsHash(a, planBuildContext(a));
    expect(ha).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeDepsHash(b, planBuildContext(b))).toBe(ha);
    writeFileSync(join(b, 'programs/server/npm/node_modules/x/package.json'), '{"name":"x","version":"1.0.1"}');
    expect(await computeDepsHash(b, planBuildContext(b))).not.toBe(ha);
  });

  it('does not change when only app code changes', async () => {
    const a = copyBundle();
    const h = await computeDepsHash(a, planBuildContext(a));
    writeFileSync(join(a, 'programs/server/app/app.js'), '// changed');
    expect(await computeDepsHash(a, planBuildContext(a))).toBe(h);
  });
});
