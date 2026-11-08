import { describe, expect, it } from 'vitest';
import { parseBuildxPlatforms } from '../../../src/local/docker.js';
import { run } from '../../../src/local/exec.js';

describe('run', () => {
  it('runs a command without a shell and captures output', async () => {
    await expect(run('node', ['-e', 'console.log(1)'])).resolves.toEqual({ code: 0, stdout: '1\n', stderr: '' });
  });

  it('passes arguments verbatim (no shell expansion)', async () => {
    const r = await run('node', ['-e', 'console.log(process.argv[1])', '$HOME; echo hi']);
    expect(r.stdout).toBe('$HOME; echo hi\n');
  });

  it('feeds input, reports lines and exit codes', async () => {
    const lines: string[] = [];
    const r = await run('node', ['-e', 'process.stdin.pipe(process.stdout); process.stdin.on("end", () => process.exit(3))'], {
      input: 'a\nb\n',
      onLine: (l, s) => lines.push(`${s}:${l}`),
    });
    expect(r.code).toBe(3);
    expect(lines).toEqual(['stdout:a', 'stdout:b']);
  });

  it('resolves code 127 when the command does not exist', async () => {
    const r = await run('definitely-not-a-command-xyz', []);
    expect(r.code).toBe(127);
    expect(r.stderr).toMatch(/ENOENT|not found/);
  });
});

describe('parseBuildxPlatforms', () => {
  it('reads all Platforms lines and strips markers', () => {
    const out = 'Name:   desktop-linux\nNodes:\nName: desktop-linux\nPlatforms: linux/arm64, linux/amd64*, linux/amd64/v2, linux/riscv64\n';
    expect(parseBuildxPlatforms(out)).toEqual(['linux/arm64', 'linux/amd64', 'linux/amd64/v2', 'linux/riscv64']);
  });
});
