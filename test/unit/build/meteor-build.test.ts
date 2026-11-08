import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { meteorArchFor, meteorBuildArgs, runMeteorBuild } from '../../../src/build/meteor-build.js';
import type { AppConfig } from '../../../src/config/types.js';
import { CometError } from '../../../src/core/errors.js';
import { createReporter } from '../../../src/output/reporter.js';
import { tempDir } from '../../helpers/fs.js';

const app = (buildOptions: Record<string, unknown>): AppConfig =>
  ({ name: 'a', path: '.', type: 'meteor', servers: {}, env: {}, docker: {}, buildOptions: { buildLocation: '/b', ...buildOptions } }) as unknown as AppConfig;
const X64 = 'os.linux.x86_64' as const;

describe('meteorArchFor', () => {
  it('maps platforms to Meteor architectures', () => {
    expect(meteorArchFor('linux/amd64')).toBe('os.linux.x86_64');
    expect(meteorArchFor('linux/arm64')).toBe('os.linux.aarch64');
  });
});

describe('meteorBuildArgs (ref. §4.1)', () => {
  it('serverOnly', () => {
    expect(meteorBuildArgs(app({ serverOnly: true }), '/L', X64, '/app')).toEqual(['build', '--directory', '/L', '--architecture', 'os.linux.x86_64', '--server-only']);
  });

  it('debug + mobileSettings + server', () => {
    expect(meteorBuildArgs(app({ debug: true, mobileSettings: { a: 1 }, server: 'https://x' }), '/L', X64, '/app')).toEqual([
      'build', '--directory', '/L', '--architecture', 'os.linux.x86_64',
      '--debug', '--mobile-settings', '{"a":1}', '--server', 'https://x',
    ]);
  });

  it("uses the app's settings.json without serverOnly and mobileSettings", () => {
    expect(meteorBuildArgs(app({}), '/L', X64, '/app')).toEqual([
      'build', '--directory', '/L', '--architecture', 'os.linux.x86_64', '--mobile-settings', join('/app', 'settings.json'),
    ]);
  });

  it('accepts allowIncompatibleUpdates and allowIncompatibleUpdate', () => {
    expect(meteorBuildArgs(app({ serverOnly: true, allowIncompatibleUpdates: true }), '/L', X64, '/app')).toContain('--allow-incompatible-update');
    expect(meteorBuildArgs(app({ serverOnly: true, allowIncompatibleUpdate: true }), '/L', X64, '/app')).toContain('--allow-incompatible-update');
    expect(meteorBuildArgs(app({ serverOnly: true }), '/L', X64, '/app')).not.toContain('--allow-incompatible-update');
  });

  it('passes the arm64 architecture', () => {
    expect(meteorBuildArgs(app({ serverOnly: true }), '/L', 'os.linux.aarch64', '/app')).toContain('os.linux.aarch64');
  });
});

describe('runMeteorBuild', () => {
  const reporter = () => createReporter({ verbose: false, tty: false, write: () => {} });

  function fakeMeteor(body: string): string {
    const dir = tempDir({ 'meteor.sh': `#!/bin/sh\n${body}\n` });
    const p = join(dir, 'meteor.sh');
    chmodSync(p, 0o755);
    return p;
  }

  it('cleans the build location, runs headless in the app dir and returns the bundle dir', async () => {
    const appPath = tempDir({ '.meteor/release': 'METEOR@3.5.4' });
    const buildLocation = tempDir({ 'stale.txt': 'old' });
    const exe = fakeMeteor('mkdir -p "$3/bundle"; echo "$METEOR_HEADLESS $(pwd) $*" > "$3/bundle/args.txt"');
    const bundle = await runMeteorBuild(app({ serverOnly: true, cleanBuildLocation: true, executable: exe }), {
      appPath, buildLocation, arch: X64, reporter: reporter(),
    });
    expect(bundle).toBe(join(buildLocation, 'bundle'));
    expect(existsSync(join(buildLocation, 'stale.txt'))).toBe(false);
    const args = readFileSync(join(bundle, 'args.txt'), 'utf8');
    expect(args).toContain('1 ');
    expect(args).toContain(`build --directory ${buildLocation} --architecture os.linux.x86_64 --server-only`);
  });

  it('fails with the last lines of output', async () => {
    const appPath = tempDir({ '.meteor/release': 'METEOR@3.5.4' });
    const exe = fakeMeteor('for i in $(seq 1 80); do echo "line $i"; done; echo "Errors prevented bundling" >&2; exit 1');
    const p = runMeteorBuild(app({ serverOnly: true, executable: exe }), { appPath, buildLocation: tempDir(), arch: X64, reporter: reporter() });
    await expect(p).rejects.toThrow(CometError);
    await expect(
      runMeteorBuild(app({ serverOnly: true, executable: exe }), { appPath, buildLocation: tempDir(), arch: X64, reporter: reporter() }),
    ).rejects.toThrow(/line 80[\s\S]*Errors prevented bundling/);
  });

  it('rejects a directory that is not a Meteor app', async () => {
    await expect(runMeteorBuild(app({}), { appPath: tempDir(), buildLocation: tempDir(), arch: X64, reporter: reporter() })).rejects.toThrow(/\.meteor/);
  });

  it('keeps the build location without cleanBuildLocation', async () => {
    const appPath = tempDir({ '.meteor/release': 'METEOR@3.5.4' });
    const buildLocation = tempDir({ 'keep.txt': 'x' });
    writeFileSync(join(buildLocation, 'keep.txt'), 'x');
    await runMeteorBuild(app({ serverOnly: true, executable: fakeMeteor('mkdir -p "$3/bundle"') }), { appPath, buildLocation, arch: X64, reporter: reporter() });
    expect(existsSync(join(buildLocation, 'keep.txt'))).toBe(true);
  });
});
