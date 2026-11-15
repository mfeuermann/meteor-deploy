/**
 * The app image of MUP's bundle mode (spec 2026-11-15 bundle mode §4.2): the base image
 * (`app.docker.image`) unchanged plus one layer with `/bundle/bundle.tar.gz`, which the base
 * image unpacks, installs and runs every time the container starts. MUP mounts the same file
 * from `/opt/<app>/current`; here it is in the image, so a version stays an image and the rest
 * of comet-deploy (distribution, retag, rollback) does not change.
 *
 * The image is made without a Dockerfile: `docker create` (the container never starts), `docker
 * cp` of a tar stream into it, `docker commit`. So no ONBUILD instruction of the base image runs
 * (`kadirahq/meteord` has ONBUILD steps that would try to build Meteor from source), nothing
 * runs that would need emulation of another architecture, and buildx is not involved.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { c as createTar, Header } from 'tar';
import type { Platform } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { run } from '../local/exec.js';

/**
 * Format version of the bundle image, part of the input hash in bundle mode: raising it makes
 * every cached bundle image count as changed.
 */
export const BUNDLE_IMAGE_VERSION = 1;

/** `run` from src/local/exec.ts; a parameter so tests can replace the docker CLI. */
export type RunFn = typeof run;

/**
 * Writes `<buildLocation>/bundle.tar.gz` from `<buildLocation>/bundle` the way MUP does
 * (node-tar, `portable`, gzip level 9, every entry under `bundle/`). Returns its path.
 */
export async function writeBundleArchive(buildLocation: string): Promise<string> {
  const file = join(buildLocation, 'bundle.tar.gz');
  await createTar({ file, cwd: buildLocation, portable: true, gzip: { level: 9 } }, ['bundle']);
  return file;
}

const BLOCK = 512;

/** One ustar header block, owned by root. */
function headerBlock(o: { path: string; type: 'Directory' | 'File'; mode: number; size: number; mtime: Date }): Buffer {
  const h = new Header({ ...o, uid: 0, gid: 0, uname: 'root', gname: 'root' });
  const block = Buffer.alloc(BLOCK);
  h.encode(block, 0);
  return block;
}

/**
 * The tar stream `docker cp` writes into the image: exactly `bundle/` (directory, root:root
 * 0755, as `sudo mkdir current` in MUP's meteor-start.sh) and `bundle/bundle.tar.gz` (root:root
 * 0644, as `sudo cp`). Written block by block, so no other entry, owner or mode can slip in.
 * `docker cp` applies owner and mode from the headers, also over a `/bundle` the base image
 * already has.
 */
export function bundleLayerTar(archive: Buffer): Buffer {
  const mtime = new Date();
  const pad = Buffer.alloc((BLOCK - (archive.length % BLOCK)) % BLOCK);
  return Buffer.concat([
    headerBlock({ path: 'bundle/', type: 'Directory', mode: 0o755, size: 0, mtime }),
    headerBlock({ path: 'bundle/bundle.tar.gz', type: 'File', mode: 0o644, size: archive.length, mtime }),
    archive,
    pad,
    // End of archive: two zero blocks.
    Buffer.alloc(2 * BLOCK),
  ]);
}

/**
 * Creates the bundle image `tag` for `platform` from `baseImage` and the archive at
 * `archivePath` (see the file comment). The temporary container is removed in every case.
 *
 * @throws CometError when the base image is not available for the platform, or when copying,
 *   committing or reading the new image fails.
 */
export async function createBundleImage(o: {
  baseImage: string;
  platform: Platform;
  archivePath: string;
  tag: string;
  labels: Record<string, string>;
  run?: RunFn;
}): Promise<{ imageId: string }> {
  const exec = o.run ?? run;
  const created = await exec('docker', ['create', '--platform', o.platform, o.baseImage]);
  if (created.code !== 0) {
    throw new CometError(`The docker image "${o.baseImage}" is not available for ${o.platform}: ${created.stderr.trim()}`, {
      hint: `In bundle mode the servers run this image itself. Use an image that exists for ${o.platform}, or a zodern/meteor image.`,
    });
  }
  const cid = created.stdout.trim();
  const failed = (stderr: string) => new CometError(`Creating the bundle image ${o.tag} failed: ${stderr.trim()}`);
  try {
    const cp = await exec('docker', ['cp', '-', `${cid}:/`], { input: bundleLayerTar(await readFile(o.archivePath)) });
    if (cp.code !== 0) throw failed(cp.stderr);
    const changes = Object.entries(o.labels).flatMap(([k, v]) => ['--change', `LABEL ${k}=${v}`]);
    const commit = await exec('docker', ['commit', ...changes, cid, o.tag]);
    if (commit.code !== 0) throw failed(commit.stderr);
    const id = await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', o.tag]);
    if (id.code !== 0 || !id.stdout.trim()) throw failed(id.stderr || 'no image id');
    return { imageId: id.stdout.trim() };
  } finally {
    await exec('docker', ['rm', '-f', cid]);
  }
}
