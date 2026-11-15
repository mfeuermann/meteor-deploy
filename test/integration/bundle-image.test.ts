/**
 * The bundle image (spec 2026-11-15 bundle mode §4.2) against the local Docker, without the
 * network: a small base image with an ONBUILD step that would fail, its own /bundle (app-owned,
 * 700, like zodern/meteor:root) and an ENTRYPOINT that prints owner and mode of the bundle.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { arch } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBundleImage, writeBundleArchive } from '../../src/build/bundle-image.js';
import { run } from '../../src/local/exec.js';
import { tempDir } from '../helpers/fs.js';

// Already local for the transfer tests; pulled only when it is missing.
const FROM = 'busybox:1.36';
const BASE = `comet-test-bundle-base:${process.pid}`;
const TAG = `comet-test-bundle-app:${process.pid}`;
const VOLUME_BASE = `comet-test-bundle-volume:${process.pid}`;
const PLATFORM = arch() === 'arm64' ? 'linux/arm64' : 'linux/amd64';

const DOCKERFILE = `FROM ${FROM}
RUN mkdir -m 700 /bundle && chown 1:1 /bundle
ONBUILD RUN exit 1
ENTRYPOINT ["sh", "-c", "stat -c '%u:%g %a %n' /bundle /bundle/bundle.tar.gz"]
`;

async function docker(args: string[], input?: string): Promise<string> {
  const r = await run('docker', args, { input });
  if (r.code !== 0) throw new Error(`docker ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

describe('bundle image on the local Docker', () => {
  let archive: string;

  beforeAll(async () => {
    if ((await run('docker', ['image', 'inspect', FROM])).code !== 0) await docker(['pull', FROM]);
    await docker(['build', '-t', BASE, '-'], DOCKERFILE);
    archive = await writeBundleArchive(tempDir({ 'bundle/main.js': 'console.log(1)', 'bundle/programs/server/boot.js': 'x' }));
    await createBundleImage({
      baseImage: BASE,
      platform: PLATFORM,
      archivePath: archive,
      tag: TAG,
      labels: { 'comet-deploy.version': '20261115-120000', 'comet-deploy.bundle': '1' },
    });
  });

  afterAll(async () => {
    await run('docker', ['rmi', '-f', TAG, BASE, VOLUME_BASE]);
  });

  it('gives /bundle and bundle.tar.gz the owner and mode of MUP, over the base image /bundle', async () => {
    expect((await docker(['run', '--rm', TAG])).split('\n')).toEqual(['0:0 755 /bundle', '0:0 644 /bundle/bundle.tar.gz']);
  });

  it('keeps the ENTRYPOINT and sets both labels (ONBUILD did not run)', async () => {
    const info = JSON.parse(await docker(['image', 'inspect', TAG]))[0];
    expect(info.Config.Entrypoint).toEqual(['sh', '-c', "stat -c '%u:%g %a %n' /bundle /bundle/bundle.tar.gz"]);
    expect(info.Config.Labels).toMatchObject({ 'comet-deploy.version': '20261115-120000', 'comet-deploy.bundle': '1' });
  });

  it('holds the archive unchanged', async () => {
    const inImage = await docker(['run', '--rm', '--entrypoint', 'sha256sum', TAG, '/bundle/bundle.tar.gz']);
    expect(inImage.split(/\s+/)[0]).toBe(createHash('sha256').update(readFileSync(archive)).digest('hex'));
  });

  it('refuses a base image with VOLUME /bundle, whose content docker commit would leave out', async () => {
    await docker(['build', '-t', VOLUME_BASE, '-'], `FROM ${FROM}\nVOLUME /bundle\n`);
    const p = createBundleImage({ baseImage: VOLUME_BASE, platform: PLATFORM, archivePath: archive, tag: `${TAG}-volume`, labels: {} });
    await expect(p).rejects.toThrow(`The docker image "${VOLUME_BASE}" declares /bundle as a volume`);
  });

  it('leaves no temporary container behind', async () => {
    expect(await docker(['ps', '-aq', '--filter', `ancestor=${BASE}`])).toBe('');
  });
});
