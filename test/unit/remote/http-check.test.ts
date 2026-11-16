import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkFromHere, checkUrlsFromHere } from '../../../src/remote/http-check.js';

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
}

describe('checkFromHere', () => {
  it('returns the HTTP status', async () => {
    const url = await serve((_req, res) => res.writeHead(503).end('down'));
    expect(await checkFromHere(url)).toBe('503');
  });

  it('does not follow a redirect', async () => {
    const url = await serve((_req, res) => res.writeHead(301, { location: 'https://elsewhere.invalid/' }).end());
    expect(await checkFromHere(url)).toBe('301');
  });

  it('a closed port is connection refused', async () => {
    const url = await serve(() => {});
    server!.close();
    await new Promise((r) => server!.once('close', r));
    expect(await checkFromHere(url)).toBe('connection refused');
  });

  it('no answer in time is a timeout', async () => {
    const url = await serve(() => {});
    expect(await checkFromHere(url, 100)).toBe('timeout');
  });

  it('an unknown host is a DNS lookup failure, a bad URL says so', async () => {
    expect(await checkFromHere('http://comet-deploy-test.invalid/', 2000)).toBe('DNS lookup failed');
    expect(await checkFromHere('not a url')).toBe('invalid URL');
  });
});

describe('checkUrlsFromHere', () => {
  it('one local check per distinct URL, in parallel', async () => {
    const calls: string[] = [];
    const check = async (url: string) => (calls.push(url), url.endsWith('a/') ? '200' : 'timeout');
    const r = await checkUrlsFromHere(['https://a/', 'https://b/', 'https://a/'], check);
    expect(calls).toEqual(['https://a/', 'https://b/']);
    expect([...r]).toEqual([
      ['https://a/', '200'],
      ['https://b/', 'timeout'],
    ]);
  });
});
