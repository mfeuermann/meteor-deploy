/**
 * The CLI as npm installs it: `node_modules/.bin/comet-deploy` is a symlink to
 * dist/cli/main.js (C1: the entry check must resolve symlinks).
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const run = promisify(execFile);

describe('installed bin', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' });
  });

  it('runs through a symlink like node_modules/.bin/comet-deploy', async () => {
    const bin = join(mkdtempSync(join(tmpdir(), 'comet-bin-')), 'comet-deploy');
    symlinkSync(join(root, 'dist/cli/main.js'), bin);
    const { stdout } = await run(process.execPath, [bin, '--version']);
    expect(stdout.trim()).toBe('0.1.0');
    const help = await run(process.execPath, [bin, '--help']);
    expect(help.stdout).toContain('deploy');
  });

  it('exits non-zero on an error', async () => {
    const err = await run(process.execPath, [join(root, 'dist/cli/main.js'), 'deploy', '--config', '/nonexistent/mup.js']).catch((e) => e);
    expect(err.code).toBe(1);
    expect(err.stderr).toMatch(/Error/);
  });
});
