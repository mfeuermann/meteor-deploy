import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Parser, t } from 'tar';
import { describe, expect, it } from 'vitest';
import { bundleLayerTar, createBundleImage, writeBundleArchive } from '../../../src/build/bundle-image.js';
import { CometError } from '../../../src/core/errors.js';
import type { RunOptions, RunResult } from '../../../src/local/exec.js';
import { tempDir } from '../../helpers/fs.js';

interface ParsedEntry {
  path: string;
  type: string;
  mode: number | undefined;
  uid: number | undefined;
  gid: number | undefined;
  size: number | undefined;
  data: Buffer;
}

/** Parses an uncompressed tar buffer into its entries (headers and contents). */
function parseTar(buf: Buffer): Promise<ParsedEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: ParsedEntry[] = [];
    const p = new Parser({
      onReadEntry: (e) => {
        const chunks: Buffer[] = [];
        e.on('data', (c: Buffer) => chunks.push(c));
        e.on('end', () =>
          entries.push({ path: e.path, type: e.type, mode: e.mode, uid: e.uid, gid: e.gid, size: e.size, data: Buffer.concat(chunks) }),
        );
      },
    });
    p.on('end', () => resolve(entries));
    p.on('error', reject);
    p.end(buf);
  });
}

/** A fake `run` that records its calls and answers from `answer` (default: success, no output). */
function fakeRun(answer: (cmd: string, args: string[]) => Partial<RunResult> = () => ({})) {
  const calls: { cmd: string; args: string[]; input: RunOptions['input'] }[] = [];
  const run = async (cmd: string, args: string[], o: RunOptions = {}): Promise<RunResult> => {
    calls.push({ cmd, args, input: o.input });
    return { code: 0, stdout: '', stderr: '', ...answer(cmd, args) };
  };
  return { run, calls };
}

describe('writeBundleArchive', () => {
  it('packs bundle/ as gzip with every entry under bundle/', async () => {
    const loc = tempDir({ 'bundle/main.js': 'main', 'bundle/programs/server/x.js': 'x' });
    const file = await writeBundleArchive(loc);
    expect(file).toBe(join(loc, 'bundle.tar.gz'));
    const bytes = readFileSync(file);
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
    const paths: string[] = [];
    await t({ file, onReadEntry: (e) => paths.push(e.path) });
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.startsWith('bundle/'))).toBe(true);
    expect(paths).toContain('bundle/main.js');
    expect(paths).toContain('bundle/programs/server/x.js');
  });
});

describe('bundleLayerTar', () => {
  it('has exactly the two entries of spec §4.2', async () => {
    const archive = Buffer.from('not really gzip, but bytes '.repeat(50));
    const entries = await parseTar(bundleLayerTar(archive));
    expect(entries.map(({ data: _d, ...e }) => e)).toEqual([
      { path: 'bundle/', type: 'Directory', mode: 0o755, uid: 0, gid: 0, size: 0 },
      { path: 'bundle/bundle.tar.gz', type: 'File', mode: 0o644, uid: 0, gid: 0, size: archive.length },
    ]);
    expect(entries[1].data.equals(archive)).toBe(true);
  });
});

describe('createBundleImage', () => {
  const archiveFile = () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'b'));
    const p = join(dir, 'bundle.tar.gz');
    writeFileSync(p, 'archive');
    return p;
  };
  const opts = (run: ReturnType<typeof fakeRun>['run'], platform: 'linux/amd64' | 'linux/arm64' = 'linux/amd64') => ({
    baseImage: 'kadirahq/meteord',
    platform,
    archivePath: archiveFile(),
    tag: 'mup-a:v1',
    labels: { 'comet-deploy.version': 'v1', 'comet-deploy.bundle': '1' },
    run,
  });

  it('runs create, cp and commit and removes the container', async () => {
    const f = fakeRun((_c, args) => {
      if (args[0] === 'create') return { stdout: 'cid123\n' };
      if (args[0] === 'image') return { stdout: 'sha256:img\n' };
      return {};
    });
    const r = await createBundleImage(opts(f.run));
    expect(r).toEqual({ imageId: 'sha256:img' });
    expect(f.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ['docker', 'image', 'inspect', '--format', '{{json .Config.Volumes}}', 'kadirahq/meteord'],
      ['docker', 'create', '--platform', 'linux/amd64', 'kadirahq/meteord'],
      ['docker', 'cp', '-', 'cid123:/'],
      ['docker', 'commit', '--change', 'LABEL comet-deploy.version=v1', '--change', 'LABEL comet-deploy.bundle=1', 'cid123', 'mup-a:v1'],
      ['docker', 'image', 'inspect', '--format', '{{.Id}}', 'mup-a:v1'],
      ['docker', 'rm', '-f', 'cid123'],
    ]);
    const input = f.calls[2].input;
    expect(Buffer.isBuffer(input)).toBe(true);
    const entries = await parseTar(input as Buffer);
    expect(entries.map((e) => e.path)).toEqual(['bundle/', 'bundle/bundle.tar.gz']);
    expect(entries[1].data.toString()).toBe('archive');
  });

  it('removes the container when commit fails', async () => {
    const f = fakeRun((_c, args) => {
      if (args[0] === 'create') return { stdout: 'cid123\n' };
      if (args[0] === 'commit') return { code: 1, stderr: 'no space\n' };
      return {};
    });
    await expect(createBundleImage(opts(f.run))).rejects.toThrow(/Creating the bundle image mup-a:v1 failed: no space/);
    expect(f.calls.at(-1)?.args).toEqual(['rm', '-f', 'cid123']);
  });

  it('refuses a base image that declares /bundle as a volume', async () => {
    // docker commit leaves volume content out: the image would have no bundle.
    for (const volumes of ['{"/bundle":{}}', '{"/bundle/":{}}', '{"/":{}}']) {
      const f = fakeRun((_c, args) => (args[0] === 'image' && args.includes('{{json .Config.Volumes}}') ? { stdout: `${volumes}\n` } : {}));
      const err = await createBundleImage(opts(f.run)).catch((e: unknown) => e);
      expect(err, volumes).toBeInstanceOf(CometError);
      expect((err as CometError).message).toMatch(/^The docker image "kadirahq\/meteord" declares \/(bundle\/?)? as a volume, so the bundle cannot be part of the app image/);
      expect(f.calls.some((c) => c.args[0] === 'create'), volumes).toBe(false);
    }
  });

  it('accepts other volumes of the base image', async () => {
    const f = fakeRun((_c, args) => {
      if (args.includes('{{json .Config.Volumes}}')) return { stdout: '{"/data":{}}\n' };
      if (args[0] === 'create') return { stdout: 'cid123\n' };
      if (args[0] === 'image') return { stdout: 'sha256:img\n' };
      return {};
    });
    await expect(createBundleImage(opts(f.run))).resolves.toEqual({ imageId: 'sha256:img' });
  });

  it('reports a base image missing for the platform', async () => {
    const f = fakeRun((_c, args) => (args[0] === 'create' ? { code: 1, stderr: 'no matching manifest for linux/arm64\n' } : {}));
    const err = await createBundleImage(opts(f.run, 'linux/arm64')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CometError);
    expect((err as CometError).message).toBe('The docker image "kadirahq/meteord" is not available for linux/arm64: no matching manifest for linux/arm64');
    expect((err as CometError).hint).toBe(
      'In bundle mode the servers run this image itself. Use an image that exists for linux/arm64 ("docker buildx imagetools inspect kadirahq/meteord" lists its platforms).',
    );
    expect(f.calls.some((c) => c.args[0] === 'rm')).toBe(false);
  });
});
