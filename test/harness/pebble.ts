/**
 * Pebble, Let's Encrypt's ACME test server, inside a fake server, so the proxy's Let's Encrypt
 * companion (jrcs/letsencrypt-nginx-proxy-companion v1.13.1, which runs simp_le) can get a real
 * certificate without the internet:
 *
 * - Pebble runs in the network namespace of the companion container, so the companion reaches it
 *   as `https://localhost:14000`, a name Pebble's own TLS certificate is valid for.
 * - `PEBBLE_VA_ALWAYS_VALID=1` skips the HTTP challenge, so no DNS for the test domain is needed.
 * - Pebble's CA goes into `/opt/mup-nginx-proxy/mounted-certs`, which the companion sees as
 *   `/etc/nginx/certs` (`--volumes-from mup-nginx-proxy`); simp_le uses python-requests, which
 *   trusts the file named by `REQUESTS_CA_BUNDLE`.
 *
 * The config points the companion at Pebble with `proxy.shared.envLetsEncrypt` (`pebbleEnv()`),
 * applied by `proxy reconfig-shared`. The companion container is recreated by every proxy
 * restart, which takes Pebble's network with it: call `startPebble` again after one.
 */
import type { FakeServer } from './fake-servers.js';

/** A pinned Pebble release (multi-arch image). */
export const PEBBLE_IMAGE = 'ghcr.io/letsencrypt/pebble:2.6.0';
const COMPANION = 'mup-nginx-proxy-letsencrypt';
const CA_FILE = 'pebble-ca.pem';
const ACME_URI = 'https://localhost:14000/dir';
const CA_PATH = `/etc/nginx/certs/${CA_FILE}`;

/** The `proxy.shared.envLetsEncrypt` that points the companion at Pebble. */
export function pebbleEnv(): Record<string, string | boolean> {
  return { ACME_CA_URI: ACME_URI, REQUESTS_CA_BUNDLE: CA_PATH, DEBUG: true };
}

/**
 * (Re)starts Pebble beside the companion on `server` and copies its CA where the companion reads
 * it. Resolves once Pebble listens; throws with Pebble's log otherwise.
 */
export async function startPebble(server: FakeServer): Promise<{ acmeUri: string; caPath: string }> {
  // PEBBLE_WFE_NONCEREJECT=0: Pebble rejects 5% of the nonces by default to test clients' retries.
  const r = await server.exec(`set -e
docker rm -f pebble > /dev/null 2>&1 || true
docker run -d --name pebble --network container:${COMPANION} \\
  -e PEBBLE_VA_ALWAYS_VALID=1 -e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 \\
  ${PEBBLE_IMAGE} > /dev/null
docker cp pebble:/test/certs/pebble.minica.pem /opt/mup-nginx-proxy/mounted-certs/${CA_FILE}`);
  if (r.code !== 0) throw new Error(`Starting Pebble failed: ${r.stderr || r.stdout}`);
  const deadline = Date.now() + 60_000;
  let log = '';
  while (Date.now() < deadline) {
    log = (await server.exec('docker logs pebble 2>&1')).stdout;
    if (/Listening on: .*14000/.test(log)) return { acmeUri: ACME_URI, caPath: CA_PATH };
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`Pebble did not start listening within 60s:\n${log.slice(-2000)}`);
}
