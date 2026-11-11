/**
 * `validate --scrub`: a copy of the normalized config with hosts, credentials, the app name
 * and URLs replaced, for sharing in bug reports. The output is meant to be identical to
 * `mup validate --scrub`. Like MUP, it does not touch other `app.env` values, so the scrubbed
 * config can still contain secrets such as API keys.
 */
import { parse } from 'node:url';
import cloneDeep from 'lodash/cloneDeep.js';
import type { NormalizedConfig } from './types.js';

/**
 * Port of MUP's scrubUrl. Credentials become `user:pass@`, the last two host labels become
 * `host.com` and every other label `subdomain.`; the scheme, port, path (with the query
 * string) and hash are kept. It uses the legacy `url.parse` on purpose: MUP does, and WHATWG
 * `URL` normalizes differently and rejects strings such as a MongoDB URL with several hosts.
 */
export function scrubUrl(url: string): string {
  const { protocol, auth, hostname, port, path, hash } = parse(url);
  let href = `${protocol}//`;
  if (auth) href += 'user:pass@';
  const domains = (hostname ?? '').split('.');
  domains.pop();
  domains.pop();
  for (let i = 0; i < domains.length; i++) href += 'subdomain.';
  href += 'host.com';
  if (port) href += `:${port}`;
  if (path && path !== '/') href += path;
  if (hash) href += hash;
  return href;
}

/** Scrubs a comma-separated domain list by running each name through scrubUrl. */
function scrubDomains(domains: string): string {
  return domains
    .split(',')
    .map((d) => scrubUrl(`http://${d.trim()}`).slice(7))
    .join(',');
}

/** Same output as `mup validate --scrub` (MUP's default, docker, meteor and proxy scrubbers). */
export function scrubConfig(input: NormalizedConfig): NormalizedConfig {
  const config: any = cloneDeep(input);
  for (const server of Object.values<any>(config.servers ?? {})) {
    if (!server || typeof server !== 'object') continue;
    if ('host' in server) server.host = '1.2.3.4';
    if ('password' in server) server.password = 'password';
    if ('pem' in server) server.pem = '~/.ssh/pem';
  }
  if (config.privateDockerRegistry) {
    if (config.privateDockerRegistry.username) config.privateDockerRegistry.username = 'username';
    if (config.privateDockerRegistry.password) config.privateDockerRegistry.password = 'password';
  }
  // `app` holds a copy of it after normalization.
  if (config.meteor) delete config.meteor;
  if (config.app) {
    if ('name' in config.app) config.app.name = 'my-app';
    if (config.app.buildOptions?.server) config.app.buildOptions.server = scrubUrl(config.app.buildOptions.server);
    const env = config.app.env;
    if (env) {
      if (env.ROOT_URL !== undefined) env.ROOT_URL = scrubUrl(String(env.ROOT_URL));
      if (env.MONGO_URL !== undefined) {
        if (config.mongo) {
          // The built-in database URL has no secret host: only the last path segment (the
          // database name and query) is replaced.
          const parts = String(env.MONGO_URL).split('/');
          parts.pop();
          parts.push('my-app');
          env.MONGO_URL = parts.join('/');
        } else {
          env.MONGO_URL = scrubUrl(String(env.MONGO_URL));
        }
      }
    }
  }
  if (config.proxy) {
    const env = config.app?.env;
    if (env) {
      if (env.LETSENCRYPT_EMAIL) env.LETSENCRYPT_EMAIL = 'email@domain.com';
      if (env.LETSENCRYPT_HOST) env.LETSENCRYPT_HOST = scrubDomains(env.LETSENCRYPT_HOST);
      if (env.VIRTUAL_HOST) env.VIRTUAL_HOST = scrubDomains(env.VIRTUAL_HOST);
    }
    const { shared, ssl, domains } = config.proxy;
    if (ssl && ssl.letsEncryptEmail) config.proxy.ssl.letsEncryptEmail = 'email@domain.com';
    if (domains) config.proxy.domains = scrubDomains(domains);
    if (shared?.env?.DEFAULT_HOST) shared.env.DEFAULT_HOST = scrubDomains(shared.env.DEFAULT_HOST);
  }
  return config;
}
