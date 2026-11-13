# Stream Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy to servers that refuse SSH TCP forwarding by sending the whole image over SSH (`docker save | gzip | sudo docker load`), automatically in `transfer: 'auto'` and always in `transfer: 'stream'`.

**Architecture:** A new `src/transfer/stream.ts` saves one gzip archive per platform into a temp file and loads it on each server over `SshConnection.exec` with a stream stdin. Preflight decides per server between tunnel and stream from the existing forwarding probe; the pipeline's Distribute phase runs the tunnel path for some servers and the stream path for the others, and starts the local registry only when a tunnel server exists.

**Tech Stack:** TypeScript, Node ≥ 20 (`node:zlib`, `node:child_process`, `node:fs`), ssh2 through `SshConnection`, vitest, fake servers (Docker-in-Docker with sshd).

**Spec:** `docs/superpowers/specs/2026-11-13-comet-deploy-stream-design.md`

## Global Constraints

- `cometDeploy.transfer`: `auto` (default), `tunnel`, `stream` work; `registry` and `privateDockerRegistry` stay refused with the existing phase 2 message.
- After distribution a server has exactly the tag `mup-<app>:<version>` the tunnel path creates (`targetTag` in the pipeline), and no other tag from the transfer.
- Identity check is by the target tag (`sudo docker image inspect <targetTag>`), never by `.Id` (spec §4.2).
- A distribution failure on any server stops the deploy before activation: `Image distribution failed:` … hint `No server was changed.` (existing text).
- The temp archive: mode `0o600`, in `os.tmpdir()`, removed at the end of Distribute in every case and on process exit.
- Auto warning (exact): `Server "<name>": SSH port forwarding is off (<reason>), so comet-deploy sends the whole image over SSH, which is slower. To send only the changed layers, set "AllowTcpForwarding yes" in /etc/ssh/sshd_config and reload sshd.`
- Tunnel error: today's text plus ` Or set cometDeploy.transfer to "auto" to send the whole image over SSH instead.`
- `docker save` failure (exact prefix): `Saving <localTag> for the transfer over SSH failed: <stderr>`
- Docs and commits in English; no AI attribution in commits; commit on `feat/stream`.

## Review Focus

1. Ctrl+C during a long stream upload → the Distribute phase finishes, exit 130, locks released, the temp archive is gone.
2. `docker save` fails halfway (disk full) → no server touched, no lock left, no partial archive left in `os.tmpdir()`.
3. Two platforms (amd64 + arm64 servers), both streamed → each server gets its own platform's archive under `mup-<app>:<version>`, the `-<arch>` helper tag is removed.
4. `meteor push` then `deploy --cached-build` (same version) with stream → the second distribution skips every server and runs no `docker save`.
5. A local Docker that uses the containerd image store → `docker save --platform <p>` so the archive holds one platform and loads on Docker 27.5 and 29 servers.

---

### Task 1: `src/transfer/stream.ts`

**Files:**
- Create: `src/transfer/stream.ts`
- Test: `test/unit/transfer/stream.test.ts`

**Interfaces:**
- Consumes: `SshConnection.exec(cmd, { stdin: NodeJS.ReadableStream, onStdout, onStderr })`, `shq` from `src/remote/ops.ts`, `Platform` from `src/build/…`.
- Produces:
  - `export interface StreamArchive { file: string; bytes: number; localTag: string; platform: Platform }`
  - `export async function localImageStore(o?: { run?: typeof run }): Promise<'containerd' | 'classic'>` — `docker info --format '{{json .DriverStatus}}'` contains `io.containerd.snapshotter` → `containerd`.
  - `export async function saveImageArchive(o: { localTag: string; platform: Platform; app: string; store: 'containerd' | 'classic'; spawn?: typeof spawn; dir?: string }): Promise<StreamArchive>` — `docker save [--platform <p> when containerd] <localTag>` stdout → `zlib.createGzip({ level: 6 })` → file `comet-deploy-<app>-<tag-safe>-<arch>-<pid>.tar.gz`, mode 600; registers the file for removal on process exit; on failure removes the partial file and throws the Global Constraints message.
  - `export function removeArchive(a: StreamArchive): void` — unlinks (missing file is fine) and unregisters.
  - `export async function serverHasImage(conn: SshConnection, tag: string): Promise<boolean>` — `sudo docker image inspect <shq(tag)> > /dev/null 2>&1`, exit 0.
  - `export async function streamToServer(conn: SshConnection, o: { archive: StreamArchive; targetTag: string; onStatus?: (line: string) => void }): Promise<{ durationMs: number }>` — `sudo docker load` with the file as stdin; output must match `/Loaded image( ID)?: /`; when `archive.localTag !== targetTag`: `sudo docker tag <local> <target> && sudo docker rmi <local>`; then `serverHasImage(target)` must be true. Progress via `onStatus` about every 10 %: `sent 96 MB of 312 MB`. Every failure throws `CometError` (`[<server>] Loading the image failed: …`).

- [ ] **Step 1: Write the failing tests** in `test/unit/transfer/stream.test.ts` (fake `spawn` whose stdout emits a few chunks; fake connection recording commands and stdin bytes):
  - `saveImageArchive writes a gzip of docker save with mode 600 and removes it with removeArchive` — `gunzipSync(readFileSync(file))` equals the emitted bytes; `statSync(file).mode & 0o777` is `0o600`; args are `['save', 'mup-app:v1']`; after `removeArchive` the file is gone.
  - `saveImageArchive passes --platform with the containerd image store` — args `['save', '--platform', 'linux/arm64', 'mup-app:v1-arm64']`.
  - `a failing docker save leaves no file and says why` — spawn exits 1 with stderr `no space left on device` → rejects with `Saving mup-app:v1 for the transfer over SSH failed: no space left on device`; `readdirSync(dir)` is empty.
  - `streamToServer loads the archive and keeps only the target tag` — localTag `mup-app:v1-amd64`, targetTag `mup-app:v1`: commands in order `sudo docker load`, `sudo docker tag 'mup-app:v1-amd64' 'mup-app:v1' && sudo docker rmi 'mup-app:v1-amd64'`, the inspect of `mup-app:v1`; the bytes sent equal the file.
  - `streamToServer with the same tag only loads and checks` — localTag = targetTag → no `docker tag` command.
  - `a docker load that loads nothing fails` — load output `open /var/lib/docker/tmp: no space left` code 1 → rejects with `Loading the image failed`.
  - `serverHasImage is false when inspect fails`.
  - `localImageStore detects the containerd snapshotter` — fake run output `[["driver-type","io.containerd.snapshotter.v1"]]` → `containerd`; `[["Backing Filesystem","extfs"]]` → `classic`.
- [ ] **Step 2: Run** `npx vitest run test/unit/transfer/stream.test.ts`. Expected: FAIL, module `src/transfer/stream.ts` not found.
- [ ] **Step 3: Implement** the Produces block in `src/transfer/stream.ts`.
- [ ] **Step 4: Run** the same command. Expected: 8/8 PASS.
- [ ] **Step 5: Commit** `feat(stream): save, load and check an image over SSH`.

### Task 2: Preflight decides tunnel or stream per server

**Files:**
- Modify: `src/deploy/preflight.ts` (`PreflightInput.transfer`, `PreflightResult.streamServers`, `runPreflight` option `transfer`), `src/deploy/pipeline.ts` (`assertPhase1Supported`, the `d.preflight` call passes `transfer: c.cometDeploy.transfer`)
- Test: `test/unit/deploy/preflight.test.ts`, `test/unit/deploy/pipeline.test.ts` (the existing phase 2 test)

**Interfaces:**
- Produces: `PreflightInput.transfer: CometOptions['transfer']`; `PreflightResult.streamServers: string[]` (servers to stream, in input order; empty when not `distributes`); `runPreflight(ctx, servers, { …, transfer?: CometOptions['transfer'] })` skips `probeForwarding` when `transfer === 'stream'`.

- [ ] **Step 1: Write the failing tests:**
  - preflight `auto: a server without forwarding is streamed, with a warning` — `forwardingError: 'remote port forwarding failed'` on `two` → no error, `streamServers` `['two']`, warning equals the Global Constraints text with reason `remote port forwarding failed`.
  - preflight `tunnel: a server without forwarding is an error with the stream hint` — the error ends with ` Or set cometDeploy.transfer to "auto" to send the whole image over SSH instead.`
  - preflight `stream: every server is streamed and forwarding is not probed` — `runPreflight` with `transfer: 'stream'` calls no `probeForwarding` (fake connection records no `forwardIn`/probe command), `streamServers` = all servers.
  - preflight `meteor build streams nothing` — `distributes: false` → `streamServers` `[]`.
  - pipeline: replace the `cometDeploy.transfer "stream"` refusal case with `transfer stream is accepted` and keep `registry` refused.
- [ ] **Step 2: Run** `npx vitest run test/unit/deploy/preflight.test.ts test/unit/deploy/pipeline.test.ts`. Expected: the new cases FAIL (no `streamServers`, warning missing, stream refused).
- [ ] **Step 3: Implement** the Produces block; `assertPhase1Supported` refuses only `registry`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(stream): preflight picks the tunnel or the stream per server`.

### Task 3: Distribute through the tunnel and the stream

**Files:**
- Modify: `src/deploy/pipeline.ts` (`PipelineDeps`, `DEFAULT_DEPS`, the Distribute phase), `src/transfer/tunnel.ts` (the stale "planned for phase 2" hint)
- Test: `test/unit/deploy/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 1 (`localImageStore`, `saveImageArchive`, `removeArchive`, `serverHasImage`, `streamToServer`), Task 2 (`streamServers`).
- Produces: `PipelineDeps` members `localImageStore`, `saveImageArchive`, `removeArchive`, `serverHasImage`, `streamToServer` (types `typeof …`).

Behavior: stream servers first run `serverHasImage(targetTag)`; the archive of a platform is created once, lazily (a memoized promise per platform), only for stream servers that lack the version; `aborted(d.signal)` between the saves and the uploads; `ensureLocalRegistry` / pushes only when a tunnel server exists; in `auto` a `TunnelUnavailableError` from `distributeToServer` switches that server to the stream (warning text of Task 2, reason = the error message); every archive is removed in the `finally` of the Distribute phase. After each save the reporter prints `stream: <localTag> (<platform>), <size> compressed`. Server row texts: `ok <duration> (whole image, <size>)` and `ok (already on the server)`.

- [ ] **Step 1: Write the failing tests** (pipeline harness `setup()`; the fake deps record `has:<s>`, `save:<localTag>`, `stream:<s>:<targetTag>`, `remove-archive:<localTag>`):
  - `streams to the servers preflight marks and tunnels to the others` — `streamServers: ['two']` → `distribute:one:…` and `stream:two:mup-myapp:20261107-183005`, one `save:`, `remove-archive:` after the stream, registry started.
  - `a pure stream deploy starts no local registry` — `transfer: 'stream'`, both servers streamed → no `ensure-registry`, no `push:`, no `stop-registry`.
  - `a server that has the version gets nothing and no archive is saved` — `serverHasImage` true for both → no `save:`, output has `already on the server`.
  - `auto falls back to the stream when the tunnel fails at distribution` — `distributeToServer` rejects with `TunnelUnavailableError` for `two` → `stream:two:…`, the warning is printed, the deploy succeeds.
  - `tunnel does not fall back` — same failure with `transfer: 'tunnel'` → `Image distribution failed` and no `activate:`.
  - `a failing stream fails the deploy before activation and removes the archive` — `streamToServer` rejects → `Image distribution failed:` with `No server was changed.`, `remove-archive:` recorded, `release:one`, `release:two`.
  - `a failing docker save stops before any server is changed` (Review Focus 2) — `saveImageArchive` rejects with the save CometError → the deploy rejects with that message, no `stream:`, no `activate:`, `release:one`, `release:two`.
  - `two platforms get their own archive` (Review Focus 3) — amd64 `one`, arm64 `two`, both streamed → `save:mup-myapp:20261107-183005-amd64` and `…-arm64`, each server streamed with its platform's archive.
  - `an abort after the save removes the archive and exits 130` (Review Focus 1) — the signal aborts inside `saveImageArchive` → rejects with exit code 130, `remove-archive:` recorded, no `stream:`, locks released.
- [ ] **Step 2: Run** `npx vitest run test/unit/deploy/pipeline.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** the behavior above.
- [ ] **Step 4: Run** `npx vitest run test/unit`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(stream): deploy sends the whole image to servers without forwarding`.

### Task 4: Integration tests

**Files:**
- Modify: `test/harness/fake-servers.ts` (option `namePrefix`, default `'s'`), `test/integration/transfer.test.ts`
- Create: `test/integration/stream.test.ts`

- [ ] **Step 1: Write the tests:**
  - transfer.test.ts `streams an image to a server without forwarding (Docker <v>)`, for `'27.5'` and `'29'`: `saveImageArchive` of a small local image, `streamToServer` with a different target tag → `docker images` on the server lists only the target tag of that repo, `docker run --rm <target> true` exits 0; a second call is preceded by `serverHasImage` true.
  - stream.test.ts (sample app, one server with forwarding `s1`, one without `n1`, `namePrefix: 'n'`): `deploy with transfer auto reaches both servers` (exit 0, output contains `Server "n1": SSH port forwarding is off`, `curlApp` `/native` is `60` on both); `rollback works on both`; `transfer tunnel stops in preflight on the server without forwarding` (exit ≠ 0, `AllowTcpForwarding yes`, image id of `:latest` unchanged on both); `no archive is left in the temp directory` (no `comet-deploy-sampleapp-*` file in `os.tmpdir()`).
- [ ] **Step 2: Run** `npx vitest run -c vitest.integration.config.ts test/integration/transfer.test.ts test/integration/stream.test.ts`. Expected: PASS (Docker Hub DNS failures are the environment: rerun).
- [ ] **Step 3: Commit** `test(stream): stream transfer on fake servers without forwarding`.

### Task 5: Docs

**Files:**
- Modify: `docs/configuration.md` (`cometDeploy.transfer` table from spec §4.1, the "Port forwarding" paragraph), `docs/troubleshooting.md` ("AllowTcpForwarding is disabled on the server"; new "Saving or loading the image for the transfer over SSH failed"), `docs/how-it-works.md` (preflight table row, Distribute), `docs/migrating-from-mup.md`, `docs/getting-started.md`, `README.md` (requirements, limitations "A transfer without it is phase 2", roadmap), `docs/commands.md` if it mentions forwarding for `deploy`.

- [ ] **Step 1: Write the docs** from spec §4.
- [ ] **Step 2: Run** `sh -c '! grep -rn --exclude-dir=superpowers "transfer without it is phase 2\|\"stream\" is not supported" docs README.md && npm run lint'`. Expected: exit 0.
- [ ] **Step 3: Commit** `docs: stream transfer`.

### Task 6: Final verification

- [ ] **Step 1: Run** `npm run lint && npm run typecheck && npm run build && npx vitest run test/unit`. Expected: all pass.
- [ ] **Step 2: Run** the integration suite file by file (`run-integ.sh`). Expected: all pass; network failures rerun.
- [ ] **Step 3:** Whole-branch review (executing-plans Final Review), one fix pass, finishing-a-development-branch.
