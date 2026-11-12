/**
 * The npm package as a user gets it: packed from a clean checkout (the files git tracks, so
 * no dist/ from an earlier local build), installed globally into a temporary prefix, and
 * run from there. This is what `npm publish` in the release workflow ships.
 *
 * Needs the npm registry: the install fetches comet-deploy's dependencies.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const version: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

/** Runs a command; returns its exit code and combined output instead of throwing. */
function run(cmd: string, args: string[], cwd: string): { code: number; output: string } {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, output: out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('npm package', () => {
  const work = mkdtempSync(join(tmpdir(), 'comet-pack-'));
  const checkout = join(work, 'checkout');
  const prefix = join(work, 'prefix');
  const bin = join(prefix, 'bin', 'comet-deploy');
  let files: string[] = [];

  beforeAll(() => {
    // A clean checkout: tracked files plus new ones git does not ignore, as they are in the
    // working tree. node_modules is linked, so the build tools are there without an install.
    const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
    for (const rel of listed.split('\0').filter(Boolean)) {
      if (!existsSync(join(root, rel))) continue; // deleted in the working tree
      mkdirSync(dirname(join(checkout, rel)), { recursive: true });
      cpSync(join(root, rel), join(checkout, rel));
    }
    symlinkSync(join(root, 'node_modules'), join(checkout, 'node_modules'));

    const packDir = join(work, 'pack');
    mkdirSync(packDir);
    const packed = run('npm', ['pack', '--pack-destination', packDir], checkout);
    expect(packed.code, packed.output).toBe(0);
    const tarball = join(packDir, readdirSync(packDir).find((f) => f.endsWith('.tgz'))!);
    files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^package\//, ''));

    const installed = run('npm', ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', tarball], work);
    expect(installed.code, installed.output).toBe(0);
  });

  it('ships the built CLI, the templates and the license files, and nothing else', () => {
    expect(files).toContain('dist/cli/main.js');
    expect(files).toContain('templates/mup/default/mup.js.sample');
    expect(files).toContain('templates/mup/proxy/nginx.tmpl');
    expect(files).toContain('templates/comet/zd-finish.sh');
    for (const f of ['LICENSE', 'NOTICE', 'README.md', 'package.json']) expect(files).toContain(f);
    const unexpected = files.filter((f) => !/^(dist|templates)\//.test(f) && !['LICENSE', 'NOTICE', 'README.md', 'package.json'].includes(f));
    expect(unexpected).toEqual([]);
  });

  it('installs a comet-deploy command that prints the package version', () => {
    const r = run(bin, ['--version'], work);
    expect(r.code, r.output).toBe(0);
    expect(r.output.trim()).toBe(version);
  });

  it('finds its templates when installed: init writes the sample config, which validates', () => {
    const app = join(work, 'app');
    mkdirSync(join(app, '.meteor'), { recursive: true });
    writeFileSync(join(app, '.meteor/release'), 'METEOR@3.5.4\n');
    const init = run(bin, ['init'], app);
    expect(init.code, init.output).toBe(0);
    expect(readFileSync(join(app, '.deploy/mup.js'), 'utf8')).toContain("path: '../'");
    expect(existsSync(join(app, '.deploy/settings.json'))).toBe(true);
    const validate = run(bin, ['validate'], join(app, '.deploy'));
    expect(validate.code, validate.output).toBe(0);
  });
});
