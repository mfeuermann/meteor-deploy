# Proxy Certificates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `proxy status`/`status` show the certificate nginx actually serves for each domain of the app, `deploy`/`reconfig`/`proxy setup` check that a custom certificate is served, and the switch from Let's Encrypt to a custom certificate stops losing the certificate.

**Architecture:** One shell fragment (`templates/comet/proxy-served.sh`) asks nginx on `127.0.0.1:<https port>` with SNI per domain via `openssl s_client` and prints the leaf PEM as base64, plus which app containers on that server name the domain in `VIRTUAL_HOST`/`LETSENCRYPT_HOST`. Pure functions in `src/proxy/certs.ts` turn a served PEM into the line and warnings of spec §4.2; `src/proxy/served.ts` reads a server and polls for the custom certificate (§4.3). The fix (§4.4) adds a comet step before MUP's `ssl-setup.sh` and, when the reproduction shows it is needed, repeats the certificate step in the `after` phase of the proxy sync.

**Tech Stack:** TypeScript (Node ≥ 20, ESM), `node:crypto` `X509Certificate`, vitest, EJS-style templates via `cometScript`, the integration harness (fake servers, Pebble).

**Spec:** `docs/superpowers/specs/2026-11-17-comet-deploy-proxy-certs-design.md`

## Global Constraints

- Nothing from `private.key` is read back from a server, printed or logged.
- No restart of the proxy containers to fix a certificate.
- Only the app's own domains (`proxyDomains(c)`) are checked or touched.
- Templates under `templates/mup/**` stay unchanged; new steps live in `templates/comet/`.
- `status` keeps one script run (`proxy-status.sh`) per proxy server.
- Certificates are parsed with `crypto.X509Certificate`, not by parsing `openssl` text.
- Warning threshold: ≤ 14 days left. Deploy check: every 2 s, at most 30 s. Dates: UTC `YYYY-MM-DD`. Days: `Math.floor((validTo − now) / 86_400_000)`.
- Exit codes of `status`, `proxy status`, `deploy`, `reconfig`, `proxy setup` do not change because of a certificate.
- Commits on `feat/proxy-certs`, no AI attribution in messages. Heavy runs (full unit suite, typecheck, build, integration) only at the end, except the single reproduction run of Task 1.

## Review Focus

1. A domain whose certificate is gone gets the companion's self-signed `default.crt`, not a failed handshake: it must show as "not for <domain>" with a warning (Task 2 `describeServed` cases; Task 7 integration).
2. A `proxy.ssl.crt` file that holds a chain: the expected fingerprint is the first certificate's (Task 2 `certFingerprint` test).
3. `openssl s_client` hanging on a firewalled port: the fragment uses `timeout 5`, so `status` returns (Task 3 template test asserts `timeout 5 openssl s_client`).
4. A proxy server that failed earlier in the rollout is not polled for 30 s (Task 5: `finish` skips servers in `failed`).
5. `proxy setup` on a fresh server (no app container yet) does not wait 30 s and does not warn (Task 5 setup test).

---

### Task 1: Reproduce the test 7 failure and record the cause

**Files:**
- Modify: `test/integration/proxy.test.ts` (helpers near `servedFingerprint`, tests 1+2 and 7)

**Interfaces:**
- Produces: `expectServed(s: FakeServer, fingerprint: string, timeoutMs?: number): Promise<void>` and `expectStaysServed(s: FakeServer, fingerprint: string, forMs: number): Promise<void>` in `proxy.test.ts`; a ledger line `Task 1: cause: …` that Task 6 reads.

- [ ] **Step 1: Add the diagnostics helpers.** `expectServed` polls `servedFingerprint` every 1 s up to `timeoutMs` (default 30 000); on timeout it calls `expect.fail` with a message holding the served subject, issuer and fingerprint (`openssl x509 -noout -subject -issuer -fingerprint -sha256`, or `no certificate`), `ls -l /opt/mup-nginx-proxy/certs /opt/mup-nginx-proxy/mounted-certs` and `docker logs --tail 40 mup-nginx-proxy-letsencrypt 2>&1`. `expectStaysServed` checks every 3 s for `forMs` and fails with the same diagnostics at the first other fingerprint.
- [ ] **Step 2: Use them.** Test 7: replace both `expect(await waitFor(... === first/second ...)).toBe(true)` with `await expectServed(server, first)` / `await expectServed(server, second)`, and after the first one add `await expectStaysServed(server, first, 45_000)` (the companion handles the old container's removal within that window).
- [ ] **Step 3: Check the machine, then run tests 1+2 and 7 only.**
  Run first: `pmset -g log | tail -5` (no sleep pending), `pmset -g batt` (AC power), `ps aux | grep '[m]eteor-tool'` (the user's Meteor processes: never stop them; if one builds, wait).
  Run: `caffeinate -dims npx vitest run -c vitest.integration.config.ts test/integration/proxy.test.ts -t "1\+2|7\." > <workspace>/repro.log 2>&1`
  Expected (hypothesis of spec §1): test 7 fails in `expectStaysServed` or `expectServed`; the diagnostics show `mounted-certs/app.test.crt -> ./app.test/fullchain.pem` (or the link missing) and a served subject of the companion's default certificate or Pebble's.
- [ ] **Step 4: Record the outcome in the ledger.** One of: `Task 1: cause: write-through and cleanup (spec §1 hypothesis)`, `Task 1: cause: companion relinks while the old container runs`, `Task 1: cause: <other, with evidence>`, `Task 1: not reproduced deterministically (<what ls -l showed>)`. Write whether `ls -l` showed a symlink at `mounted-certs/app.test.crt` after the first custom deploy: Task 6 depends on it.
- [ ] **Step 5: Commit** `test(proxy): certificate checks print what the proxy served; the custom certificate must stay after the switch from Let's Encrypt`.

### Task 2: The certificate model

**Files:**
- Create: `src/proxy/certs.ts`
- Create: `test/fixtures/certs/` with certificates only (no keys), valid 2026-01-01 to 2126-01-01, generated once with `openssl` and committed: `le-leaf.pem` (issuer `C=US, O=Let's Encrypt, CN=R11`, subject/SAN `app.example.com`), `custom.pem` (self-signed, SAN `example.com`, `www.example.com`), `wildcard.pem` (SAN `*.example.com`), `companion-default.pem` (self-signed, CN `letsencrypt-nginx-proxy-companion`, no O), `chain.pem` (= `custom.pem` followed by a second certificate)
- Test: `test/unit/proxy/certs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ServedState = { kind: 'cert'; pem: string } | { kind: 'none' } | { kind: 'no-openssl' } | { kind: 'no-https' };
  export function parseServedValue(value: string): ServedState; // '-' → none, 'noopenssl', 'nohttps', else base64 PEM; base64 without a certificate → none
  export function certFingerprint(pem: string): string;          // first certificate, upper-case hex without colons; throws CometError when there is none
  export function localCertFingerprint(c: NormalizedConfig, basePath: string): string | null; // first cert of proxy.ssl.crt via customCertFiles; null without one or when unreadable/unparsable
  export interface ServedLine { line: string | null; problems: string[] }
  export function describeServed(server: string, domain: string, state: ServedState, o: { expected: string | null; now: Date }): ServedLine;
  ```

- [ ] **Step 1: Write the failing tests** (`now` = 2126-01-01 minus N days so the fixtures give exact day counts):
  - `describeServed('one', 'app.example.com', le, { expected: null, now })` → line `app.example.com: Let's Encrypt (R11), expires 2126-01-01 (76 days)`, no problems.
  - custom matching expected → label `proxy.ssl.crt`; custom with another expected → `…, not the certificate from proxy.ssl.crt, expires …` and problem `"one" serves another certificate for www.example.com than proxy.ssl.crt: <label>, expires 2126-01-01.` where the label is the issuer (`CN` only, since `custom.pem` has no `O`).
  - `companion-default.pem` for `app.example.com` → line contains `, not for app.example.com (CN=letsencrypt-nginx-proxy-companion)`, one problem `"one" serves a certificate that is not for app.example.com: CN=letsencrypt-nginx-proxy-companion.`, and no expiry problem even at 3 days left.
  - `wildcard.pem` for `shop.example.com` → covers, no "not for".
  - 15 days → no problem; 14 days → problem `"one" serves a certificate for app.example.com that expires in 14 days (2126-01-01).`; 0 days (expires later today) → `(0 days)` and the problem; past `validTo` → line `… expired on 2126-01-01`, problem `"one" serves an expired certificate for app.example.com (expired on 2126-01-01).`
  - `none` → line `app.example.com: no certificate (TLS handshake failed)`, problem `"one" serves no certificate for app.example.com (TLS handshake failed).`; `no-openssl` → line `app.example.com: cannot check: openssl is not installed on the server`, no per-domain problem; `no-https` → line null.
  - `parseServedValue`: `-`, `noopenssl`, `nohttps`, base64 of `le-leaf.pem`, `bm90IGEgY2VydA==` → `none`.
  - `certFingerprint(chain.pem)` equals `certFingerprint(custom.pem)`; text without a certificate throws.
  - `localCertFingerprint`: config with `proxy.ssl.crt` pointing at `chain.pem` → fingerprint of `custom.pem`; missing file → null; config with Let's Encrypt → null.
- [ ] **Step 2: Run** `npx vitest run test/unit/proxy/certs.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `src/proxy/certs.ts`.** Covering via `new X509Certificate(pem).checkHost(domain) !== undefined`. Issuer label: `O (CN)`, `CN` without `O`, the raw issuer string without either (parse the `issuer` field's `KEY=value` lines). A "not for" certificate reports only that problem. Pluralize `1 day`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(proxy): describe the certificate a proxy serves for a domain`.

### Task 3: Reading what a proxy server serves

**Files:**
- Create: `templates/comet/proxy-served.sh` (fragment, first line comment `# proxy-served.sh`)
- Create: `src/proxy/served.ts`
- Test: `test/unit/proxy/served.test.ts`

**Interfaces:**
- Consumes: `ServedState`, `parseServedValue`, `describeServed` (Task 2).
- Produces:
  ```ts
  export interface ServedOnServer { domains: Record<string, ServedState>; vhost: string[]; letsEncrypt: string[] }
  export function parseServedOutput(stdout: string, domains: string[]): ServedOnServer; // keys served.<i>, vhost.<i>, le.<i> (index into domains)
  export async function readServed(conn: SshConnection, c: NormalizedConfig): Promise<ServedOnServer>; // cometScript('proxy-served.sh', { appName, domains }) via conn.runScript
  export interface CertWaitDeps { now: () => number; sleep: (ms: number) => Promise<void> }
  export const REAL_CERT_WAIT: CertWaitDeps;
  export async function waitForCustomCert(read: () => Promise<ServedOnServer>, expected: string, domains: string[], d: CertWaitDeps, o?: { timeoutMs?: number; intervalMs?: number }): Promise<ServedOnServer>; // defaults 30 000 / 2 000; returns early when every domain serves `expected` or any is no-openssl/no-https; returns the last reading
  export function customCertWarnings(server: string, last: ServedOnServer, expected: string, domains: string[], now: Date): string[];
  ```

- [ ] **Step 1: Write the failing tests:**
  - the rendered fragment for domains `['a.test','b.test']` contains `timeout 5 openssl s_client -connect 127.0.0.1:` and `-servername` once per domain, `command -v openssl`, `docker port mup-nginx-proxy 443/tcp`, and inspects only `<app>` and `mup-proxy-configure-<app>`; it never mentions `private.key`.
  - `parseServedOutput` for `served.0=<b64>\nserved.1=-\nvhost.0=1\nvhost.1=0\nle.0=1\nle.1=0` → states, `vhost: ['a.test']`, `letsEncrypt: ['a.test']`; missing keys → `none`, empty lists.
  - `waitForCustomCert` with a fake clock: matches on the first read (1 read, no sleep); matches on the third (3 reads, 2 sleeps of 2000); never matches → stops when `now` passes 30 000 and returns the last reading; `no-openssl` → 1 read.
  - `customCertWarnings`: all match → `[]`; a mismatch → the §4.3 text `"one" serves another certificate for a.test than proxy.ssl.crt: <label>, expires <date>. Run "comet-deploy proxy setup"; "comet-deploy proxy status" shows what each proxy serves.`; `no-openssl` on any domain → exactly one `Could not check the certificate "one" serves: openssl is not installed on the server.`; `none` → `"one" serves no certificate for a.test (TLS handshake failed). Run "comet-deploy proxy setup"; …` with the same tail.
- [ ] **Step 2: Run** `npx vitest run test/unit/proxy/served.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Fragment: read the HTTPS host port from `docker port` (no port → every `served.<i>=nohttps`); without `command -v openssl` → `noopenssl`; else `timeout 5 openssl s_client … </dev/null 2>/dev/null | sed -n '/-BEGIN CERTIFICATE-/,/-END CERTIFICATE-/p;/-END CERTIFICATE-/q' | base64 -w0`, empty → `-`. Env: `docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}'` of the two containers when running; a domain counts when it is an exact item of the comma-separated `VIRTUAL_HOST` / `LETSENCRYPT_HOST`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(proxy): read the certificate each domain gets from a proxy server`.

### Task 4: `proxy status` and `status` show the served certificates

**Files:**
- Modify: `templates/comet/proxy-status.sh` (gets `domains`, includes `proxy-served.sh`)
- Modify: `src/proxy/setup.ts` (`ProxyStatusRow`, `parseProxyStatus`, `proxyStatus`, `formatProxyStatus`)
- Modify: `src/cli/commands/status.ts` (`showProxyStatus` warns)
- Test: `test/unit/proxy/setup.test.ts`

**Interfaces:**
- Consumes: `parseServedOutput`, `describeServed`, `localCertFingerprint`.
- Produces: `ProxyStatusRow.certLines: string[]` and `ProxyStatusRow.certProblems: string[]`; `proxyStatus(ctx, now?: Date)`; `parseProxyStatus(server, stdout, hostToServer, domains: string[])`.

- [ ] **Step 1: Write the failing tests:** `formatProxyStatus` with `certLines` prints `   - Served certificates:` and each line as `     - <line>` after the server's other lines and before `Drained`; a row without `certLines` prints no heading (the existing MUP-layout test stays unchanged); `parseProxyStatus` keeps MUP's `cert=` parsing and ignores `served.*`/`vhost.*`/`le.*` keys; `showProxyStatus` (through a fake conn returning a status output with one expiring certificate) prints the block and one warning line.
- [ ] **Step 2: Run** `npx vitest run test/unit/proxy/setup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `proxyStatus` renders `proxy-status.sh` with `{ appName, domains: proxyDomains(c) }`, runs `parseServedOutput` on the same stdout, and fills `certLines`/`certProblems` from `describeServed` with `expected = localCertFingerprint(c, ctx.basePath)`; an unreachable server keeps both empty. `showProxyStatus` calls `ctx.reporter.warn` for each `certProblems` entry after `info(formatProxyStatus(rows))`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(status): the certificates the proxy serves, with warnings for expiring, foreign and missing ones`.

### Task 5: The check after `deploy`, `reconfig` and `proxy setup`

**Files:**
- Modify: `src/proxy/rollout.ts` (`ProxyRolloutDeps`, `PROXY_ROLLOUT_DEPS`, `createProxyRollout`, `finish`)
- Modify: `src/proxy/setup.ts` (`proxySetup`)
- Modify: `test/helpers/proxy.ts` (`fakeProxyDeps` gets `readServed` and `certWait`, option `served?: Record<string, ServedOnServer[]>` per call)
- Test: `test/unit/proxy/rollout.test.ts`, `test/unit/proxy/setup.test.ts`

**Interfaces:**
- Consumes: `readServed`, `waitForCustomCert`, `customCertWarnings`, `REAL_CERT_WAIT`, `localCertFingerprint`.
- Produces: `ProxyRolloutDeps.readServed: typeof readServed`, `ProxyRolloutDeps.certWait: CertWaitDeps`; `proxySetup(ctx, d?: ProxyLockDeps, w?: CertWaitDeps)`.

- [ ] **Step 1: Write the failing tests:**
  - rollout, deploy with a custom certificate: `finish` returns the §4.3 warning when the fake serves another certificate; returns none when it matches; `--verbose` prints `[one] serves proxy.ssl.crt for app.test`; no `readServed` call for `restart`, `rollback`, a Let's Encrypt config, or a proxy listed in `failed`; `reconfig` checks like deploy.
  - proxySetup with a custom certificate: matching → no warning; mismatch → the §4.3 warning via `reporter.warn`; `vhost` empty → no wait (one read), verbose `[one] certificate not checked: the app does not run behind this proxy yet`, no warning; `letsEncrypt: ['app.test']` → warning `"one": the running app still asks Let's Encrypt for app.test. Run "comet-deploy reconfig" to switch it to proxy.ssl.crt.` and no wait.
- [ ] **Step 2: Run** `npx vitest run test/unit/proxy/rollout.test.ts test/unit/proxy/setup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `createProxyRollout` stores `expected = desired?.certs ? localCertFingerprint(c, ctx.basePath) : null`. `finish`, inside its `try` after the controller part, for `deploy`/`reconfig` with `expected` runs `waitForCustomCert` on every proxy of `this.s.proxies` not in `this.failed`, in parallel, and appends `customCertWarnings`; a read error is one warning `Could not check the certificate "<p>" serves: <message>.` `proxySetup` runs its check after the load-balancing container step, inside `proxy.setup`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(proxy): deploy, reconfig and proxy setup check that the proxy serves proxy.ssl.crt`.

### Task 6: The fix for the switch from Let's Encrypt

**Files:**
- Create: `templates/comet/ssl-unlink.sh`
- Modify: `src/proxy/sync.ts` (`syncCerts`; when Task 1 calls for it: `AfterStep`, `ProxyFileState.cert.leLinked`, `parseProxyState`, `planProxySync`)
- Modify: `templates/comet/proxy-state.sh` (when Task 1 calls for it: `lelinks=` line)
- Test: `test/unit/proxy/sync.test.ts`, `test/unit/proxy/setup.test.ts` (script order)

**Interfaces:**
- Consumes: the ledger line of Task 1.
- Produces: `syncCerts` runs `ssl-cleanup.sh`, the uploads, `ssl-unlink.sh`, `ssl-setup.sh`, in that order; `AfterStep` gains `'certs'`; `ProxyFileState.cert.leLinked: string[]`.

Which parts ship (spec §4.4, rulings 3): **A** (unlink) ships when Task 1's `ls -l` showed a symlink at `mounted-certs/<D>.crt`; **B** (repeat in `after`) ships only when Task 1 showed the companion acting during or after the rollout. Ledger each decision as `Task 6: Ruling: …`.

- [ ] **Step 1: Write the failing tests:**
  - A: the setup script log shows `ssl-cleanup.sh`, then the two uploads, then `ssl-unlink.sh`, then `ssl-setup.sh`; the rendered `ssl-unlink.sh` for `['a.test']` removes `/opt/mup-nginx-proxy/mounted-certs/a.test.crt` and `.key` only under `[ -L … ]` and nothing else.
  - B: `parseProxyState` reads `lelinks` (base64 list); `planProxySync` with desired certs and `leLinked: ['app.test']` → `after` starts with `'certs'`, `regenerate.after === true`, a change `custom certificate set again after Let's Encrypt`; with `leLinked: []` or without desired certs → no `'certs'` in `after`.
- [ ] **Step 2: Run** `npx vitest run test/unit/proxy/sync.test.ts test/unit/proxy/setup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** A, and B when ruled in. `applyProxySync` already handles `'certs'` in its switch.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `fix(proxy): the custom certificate survives the switch from Let's Encrypt`.

### Task 7: Integration tests, docs, changelog

**Files:**
- Modify: `test/integration/proxy.test.ts`
- Modify: `docs/commands.md`, `docs/troubleshooting.md`, `docs/migrating-from-mup.md` (only with a confirmed cause), `CHANGELOG.md` (`## [Unreleased]`)

- [ ] **Step 1: Extend the integration tests:** after test 1+2, `proxy status` output contains `Served certificates:` and `app.test: Pebble` (issuer label of Pebble's intermediate); after test 7's second deploy, `proxy status` shows `app.test: proxy.ssl.crt`; a new test 7b copies another self-signed certificate over `mounted-certs/app.test.crt`, runs `docker exec mup-nginx-proxy nginx -s reload`, then `proxy status` warns `serves another certificate for app.test than proxy.ssl.crt` and `deploy` exits 0 with the §4.3 warning, after which a `proxy setup` restores `proxy.ssl.crt` (`expectServed`).
- [ ] **Step 2: Docs:** commands.md (`proxy status` lines and warnings; deploy step 6 and `reconfig`/`proxy setup`: the check), troubleshooting (another certificate served; Let's Encrypt certificate about to expire, with `proxy logs-le`; `openssl` missing), migrating-from-mup (the switch from Let's Encrypt keeps the certificate, MUP may lose it: only with a confirmed cause), CHANGELOG `[Unreleased]` with Added (served certificates in status, the check) and Fixed (the switch, if Task 6 shipped A or B).
- [ ] **Step 3: Final verification** (the heavy runs): `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, then with the Task 1 machine checks `caffeinate -dims npx vitest run -c vitest.integration.config.ts test/integration/proxy.test.ts test/integration/proxy-lb.test.ts`. Expected: all green; test 7 passes including `expectStaysServed`.
- [ ] **Step 4: Commit** `test(proxy): served certificates end to end; docs and changelog`.
