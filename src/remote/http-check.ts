/**
 * The HTTP line of the full `status` report, measured from this computer (commands design
 * §4.4): one GET of the app's public URL, with a short answer for a person to read.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** Error codes of a failed DNS lookup. */
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL']);
/** Error codes of a failed TLS handshake or certificate check. */
const TLS_RE = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|EPROTO/;

/**
 * GETs `url` once, without following a redirect, and returns the HTTP status as a string, or
 * `timeout`, `connection refused`, `DNS lookup failed`, `TLS error`, `invalid URL`, else the
 * error code. Never throws. No connection is kept open afterwards.
 */
export function checkFromHere(url: string, timeoutMs = 5000): Promise<string> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve('invalid URL');
  }
  const request = target.protocol === 'https:' ? httpsRequest : target.protocol === 'http:' ? httpRequest : null;
  if (!request) return Promise.resolve('invalid URL');
  return new Promise((resolve) => {
    let done = false;
    const finish = (answer: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(answer);
    };
    const req = request(target, { method: 'GET', agent: false, headers: { 'user-agent': 'comet-deploy status' } }, (res) => {
      res.resume();
      finish(String(res.statusCode));
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? '';
      if (code === 'ECONNREFUSED') finish('connection refused');
      else if (DNS_CODES.has(code)) finish('DNS lookup failed');
      else if (TLS_RE.test(code)) finish('TLS error');
      else finish(code || err.message);
    });
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    req.end();
  });
}

/** Checks every distinct URL once, all in parallel; the map keeps the order of `urls`. */
export async function checkUrlsFromHere(urls: string[], check: (url: string) => Promise<string> = checkFromHere): Promise<Map<string, string>> {
  const distinct = [...new Set(urls)];
  const answers = await Promise.all(distinct.map((u) => check(u)));
  return new Map(distinct.map((u, i) => [u, answers[i]]));
}
