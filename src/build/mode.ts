/**
 * Which of MUP's two ways of running an app a config uses. Its own module so config validation
 * can ask without loading the build.
 */
import type { DockerOptions } from '../config/types.js';

/**
 * MUP's `prepareBundleSupported`: whether the base image can build an app image. An explicit
 * `docker.prepareBundle` decides; otherwise only `abernix/meteord` and `zodern/meteor` images
 * can. Without it MUP runs in bundle mode: the container installs the bundle when it starts.
 */
export function prepareBundleSupported(docker: Pick<DockerOptions, 'image' | 'prepareBundle'>): boolean {
  if ('prepareBundle' in docker) return !!docker.prepareBundle;
  return ['abernix/meteord', 'zodern/meteor'].some((img) => (docker.image ?? '').startsWith(img));
}
