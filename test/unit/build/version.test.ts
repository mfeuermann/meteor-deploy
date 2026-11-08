import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readGitInfo } from '../../../src/build/version.js';
import { run } from '../../../src/local/exec.js';
import { tempDir } from '../../helpers/fs.js';

describe('readGitInfo', () => {
  it('returns null outside a git repository', async () => {
    expect(await readGitInfo(tempDir())).toBeNull();
  });

  it('reads sha, branch and dirty state', async () => {
    const d = tempDir({ 'a.txt': '1' });
    const git = (...args: string[]) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: d });
    await git('init', '-q', '-b', 'main');
    await git('add', '.');
    await git('commit', '-q', '-m', 'init');
    const clean = await readGitInfo(d);
    expect(clean).toMatchObject({ branch: 'main', dirty: false });
    expect(clean!.sha).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(d, 'a.txt'), '2');
    expect((await readGitInfo(d))!.dirty).toBe(true);
  });
});
