import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Creates a temp directory containing `files` (relative path → content). */
export function tempDir(files: Record<string, string> = {}, prefix = 'comet-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  for (const [name, content] of Object.entries(files)) {
    const p = join(d, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return d;
}

/** Captures CLI output. */
export function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    all: () => out.join('') + err.join(''),
  };
}
