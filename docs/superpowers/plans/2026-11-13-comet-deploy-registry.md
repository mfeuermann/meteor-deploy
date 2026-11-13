# Registry Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A MUP config with `privateDockerRegistry` deploys unchanged: the image is built locally, pushed to the registry and pulled by the servers, which keep it as `mup-<lc>:<version>` exactly like the tunnel and stream transfers.

**Architecture:** A new `src/transfer/registry.ts` holds the registry naming rules, the local `docker login`/`push` and the server `pull`. `distributeImages` gets a third path (registry for every server, no local registry, no archives). start.sh is rendered as without a registry, so nothing on the server pulls at start. A server whose start.sh MUP wrote with the registry is taken over at the start of `deploy`/`reconfig` activation, and refused by `rollback`. After a full successful single-platform deploy, `<prefix>/mup-<lc>:latest` is pushed for MUP.

**Tech Stack:** TypeScript, Node ≥ 20, local docker CLI through `src/local/exec.ts` `run`, ssh2 through `SshConnection`, vitest, fake servers (Docker-in-Docker with sshd), `registry:2.8.3`, MUP 1.5.11 (devDependency) for interop.

**Spec:** `docs/superpowers/specs/2026-11-13-comet-deploy-registry-design.md`

## Global Constraints

- Server image names never get the prefix: `localImageRepo` stays `mup-<lc>`; after distribution a server has `mup-<lc>:<version>` and no tag from the registry (spec §2.2, §4.1).
- start.sh is rendered with `imagePrefix: 'mup-'` and without `privateRegistry`; meteor-start.sh keeps `privateRegistry`; docker-setup.sh gets `privateRegistry` only when both `username` and `password` are set (§4.1).
- The registry password never appears in a local command's arguments, in output, or in an error (`--password-stdin`; §3).
- Registry refs: single platform `<imagePrefix>/mup-<lc>:<version>`; multi-platform `<imagePrefix>/mup-<lc>:<version>-<arch>`; MUP tag `<imagePrefix>/mup-<lc>:latest` (§4.3, §4.6).
- No local tag created for a push survives the push (removed in `finally`, §3).
- Login happens after preflight and before the build, only with both credentials (§4.3).
- `:latest` is pushed only after `deploy`/`meteor deploy` with outcome ok, every key of `c.app.servers` selected, and exactly one built platform; a failed push is a warning (§4.6).
- The MUP-registry start.sh fingerprint is a line matching `^\s*sudo docker pull \$IMAGE\s*$` in `/opt/<app>/config/start.sh` (§4.5).
- Remote checks that the unit fakes answer with `code 0, stdout ''` report through a stdout marker, never through the exit code alone (existing fakes answer every command with success).
- Config error texts (issue = `<path> <message>`):
  - path `cometDeploy.transfer`, message `"<tunnel|stream>" cannot be used with privateDockerRegistry: with a private registry the image goes through the registry. Remove cometDeploy.transfer or set it to "registry".`
  - path `cometDeploy.transfer`, message `"registry" needs a privateDockerRegistry section (host, imagePrefix, username, password).`
  - path `privateDockerRegistry`, message `username and password go together: set both, or neither and log in to the registry yourself.`
- Command-time errors (exact, CometError):
  - `privateDockerRegistry.imagePrefix is required: it is where comet-deploy pushes the image, for example "registry.example.com/myteam".`
  - `privateDockerRegistry.imagePrefix "<prefix>" would push to <prefixRegistry>, not to the registry "<hostRegistry>" in privateDockerRegistry.host. Start it with the registry host, for example "<hostRegistry>/<prefix>".`
  - `Logging in to the registry "<host>" failed: <stderr>` hint `Check privateDockerRegistry.username and password. Nothing was built or pushed, and no server was changed.`
  - `Pushing <ref> to the registry failed: <stderr>` hint (auth) `Check that the registry account may push to "<imagePrefix>".` + (no credentials in config) ` Or log in first with "docker login <host>".`, hint (other) `Check that this computer can reach the registry "<host>".`; both end with ` No server was changed.`
  - Server pull auth hint, with credentials: `The server is not logged in to the registry: run "comet-deploy docker setup", which runs docker login on the servers.`; without: `The server is not logged in to the registry: run "sudo docker login <host>" on the server, or set privateDockerRegistry.username and password and run "comet-deploy docker setup".`
  - Rollback refusal: `Server "<s>" was last deployed by MUP with privateDockerRegistry: its start.sh pulls :latest from the registry, so a rollback would not change the version. Run "comet-deploy reconfig" first, then the rollback.`
- Auth error detection: output matches `/denied|unauthorized|authentication required|no basic auth credentials/i`.
- Heavy runs (full integration suite, typecheck, build, final review) only at the end (user's CLAUDE.md); per task only the named unit files and lint.
- Public docs and commits never mention the user's private servers or apps.

## Review Focus

1. **Registry host spelled differently in `host` and `imagePrefix`** (`https://reg.example.com/`, `REG.example.com`, `reg.example.com:443`, Docker Hub `https://index.docker.io/v1/` with `imagePrefix: 'user'`): the comparison must accept the same registry and refuse a different one. Test in Task 1 (`registryOfHost`/`assertRegistryPushable` table).
2. **Push fails after `docker tag`** (registry down, denied): the temporary local tag must still be removed, and the error must not contain the password even when docker echoes it. Test in Task 3 (`pushImage removes the tag when the push fails`, `errors never contain the password`).
3. **Server pulled the ref but `docker tag` or the final check fails**: distribution failure for that server, other servers unaffected, deploy stops before activation. Test in Task 3 (`pullFromRegistry fails when the target tag is missing`) and Task 5 (`registry pull failure stops before activation`).
4. **MUP's start.sh restored by a revert after a takeover**: the takeover tag stays on the running image and the revert restores tags captured after it, so `:latest` keeps pointing at the running version. Test in Task 4 (`takeover happens before the retag, so a failed deploy restores the adopted :latest`).
5. **`--servers` naming every app server, or `meteor deploy`** (not a subset in fact): `:latest` must still be pushed; a real subset must skip it. Test in Task 5 (`pushes :latest when --servers names every app server`).

---

### Task 1: Registry naming rules and config validation

**Files:**
- Create: `src/transfer/registry.ts`
- Modify: `src/config/validate.ts:164-166`
- Test: `test/unit/transfer/registry.test.ts` (create), `test/unit/config/validate.test.ts`

**Interfaces:**
- Produces:
  - `usesRegistry(c: NormalizedConfig): boolean` — `!!c.privateDockerRegistry`.
  - `registryRepo(c: NormalizedConfig): string` — `<imagePrefix>/mup-<lc app>`; caller ensures the prefix (Task 1 assert).
  - `registryOfHost(host: string): string` — lowercased, scheme and path stripped, `index.docker.io`/`registry-1.docker.io`/`docker.io` → `docker.io`.
  - `registryOfPrefix(prefix: string): string` — first `/`-part when it contains `.` or `:` or equals `localhost` (lowercased), else `docker.io`.
  - `assertRegistryPushable(c: NormalizedConfig): void` — no-op without a registry; throws the two command-time CometErrors of Global Constraints.

- [ ] **Step 1: Write the failing tests** in `test/unit/transfer/registry.test.ts`:
  - `registryOfHost` table: `reg.example.com` → `reg.example.com`; `https://REG.example.com/` → `reg.example.com`; `reg.example.com:5000` → `reg.example.com:5000`; `https://index.docker.io/v1/` → `docker.io`; `registry-1.docker.io` → `docker.io`.
  - `registryOfPrefix` table: `reg.example.com/team` → `reg.example.com`; `127.0.0.1:5000/x` → `127.0.0.1:5000`; `localhost/x` → `localhost`; `myteam` → `docker.io`; `myteam/sub` → `docker.io`.
  - `assertRegistryPushable`: passes for `{host:'reg.example.com', imagePrefix:'reg.example.com/team'}`, `{host:'https://index.docker.io/v1/', imagePrefix:'user'}`, `{host:'docker.io', imagePrefix:'user'}`; throws the exact "is required" text without `imagePrefix`; throws `privateDockerRegistry.imagePrefix "myteam" would push to docker.io, not to the registry "reg.example.com" in privateDockerRegistry.host. Start it with the registry host, for example "reg.example.com/myteam".` for `{host:'reg.example.com', imagePrefix:'myteam'}`; throws for `{host:'reg.example.com', imagePrefix:'reg.example.com:5000/t'}`.
  - `registryRepo` → `reg.example.com/team/mup-myapp` for app `MyApp`.
- [ ] **Step 2: Write the failing validate tests** in `test/unit/config/validate.test.ts`: the three config errors of Global Constraints, each as `{ path, message, severity: 'error' }` exactly; `transfer: 'auto'` and `'registry'` with a registry and no transfer key without a registry produce none of them.
- [ ] **Step 3: Run** `npx vitest run test/unit/transfer/registry.test.ts test/unit/config/validate.test.ts` — Expected: FAIL (module missing, issues missing).
- [ ] **Step 4: Implement** `src/transfer/registry.ts` (naming part) and the checks in `validateConfig` (transfer from `raw.cometDeploy?.transfer`, pair check on `config.privateDockerRegistry`).
- [ ] **Step 5: Run** the same command — Expected: PASS.
- [ ] **Step 6: Commit** `feat(registry): naming rules and config checks`.

### Task 2: start.sh and docker-setup.sh rendering

**Files:**
- Modify: `src/remote/app-files.ts:21-28,60,72`, `src/cli/commands/setup.ts:48`, `src/cli/commands/docker.ts:26`
- Test: `test/unit/remote/app-files.test.ts`, `test/unit/cli/setup.test.ts`, `test/unit/cli/docker.test.ts`

**Interfaces:**
- Produces: `setupRegistry(c: NormalizedConfig): RegistryConfig | undefined` in `src/transfer/registry.ts` — the registry when both `username` and `password` are set, else `undefined`; used as `privateRegistry` for docker-setup.sh and docker.ts templates.

- [ ] **Step 1: Write the failing tests:**
  - app-files: for the `registry` fixture the expected start.sh is MUP's envconfig of the same `mup.js` with `privateDockerRegistry` deleted (extend the test's MUP render helper with that option); env.list stays MUP's own. Assert also `not.toContain('docker pull $IMAGE')` and `toContain('APP_IMAGE=mup-reg-app')`.
  - app-files: `renderMeteorStart` for the registry fixture still contains `PRIVATE_REGISTRY=0` (existing test stays).
  - setup/docker: the rendered docker-setup.sh contains `docker login` with both credentials, and does not contain `docker login` when `password` is absent.
- [ ] **Step 2: Run** `npx vitest run test/unit/remote/app-files.test.ts test/unit/cli/setup.test.ts test/unit/cli/docker.test.ts` — Expected: FAIL on the registry start.sh and the no-password case.
- [ ] **Step 3: Implement:** `renderStartSh` passes `imagePrefix: 'mup-'` and no `privateRegistry` (delete the `imagePrefix()` helper, update the header comment to say why: spec §4.1); setup.ts and docker.ts pass `setupRegistry(c)`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(registry): start.sh never pulls, setup logs in only with credentials`.

### Task 3: Local login, push and server pull

**Files:**
- Modify: `src/transfer/registry.ts`
- Test: `test/unit/transfer/registry.test.ts`

**Interfaces:**
- Consumes: `run` from `src/local/exec.ts` (`input` writes stdin, `onLine` streams lines), `SshConnection.exec`, `formatFailureOutput`, `shq` from `src/remote/ops.ts`, `serverHasImage` from `src/transfer/stream.ts`.
- Produces:
  - `registryLogin(reg: RegistryConfig, o?: { run?: typeof run }): Promise<boolean>` — false (no command) without both credentials; else `docker login --username <u> --password-stdin <host>` with `input: password`; throws the login CometError.
  - `pushImage(o: { localTag: string; ref: string; reg: RegistryConfig; run?: typeof run; onLine?: (l: string) => void }): Promise<{ durationMs: number }>` — `docker tag localTag ref`, `docker push ref`, `docker rmi ref` in `finally`; throws the push CometError (hint chosen by `isAuthError`, credentials presence from `reg`).
  - `pullFromRegistry(conn: SshConnection, o: { ref: string; targetTag: string; reg: RegistryConfig; onStatus?: (l: string) => void }): Promise<{ durationMs: number }>` — `sudo docker pull <ref>`, then `sudo docker tag <ref> <targetTag> && sudo docker rmi <ref>`, then `serverHasImage(conn, targetTag)`; throws `CometError('[<server>] Pulling <ref> failed (exit code N):\n<output>[\n<auth hint>]')`, `… tagging <targetTag> failed …`, `… <targetTag> is missing on the server after docker pull.`
  - `isAuthError(output: string): boolean`.

- [ ] **Step 1: Write the failing tests** (fake `run` recording `[cmd, args, input]`, fake conn as in `test/unit/transfer/stream.test.ts`):
  - `registryLogin passes the password on stdin only`: args `['login','--username','u','--password-stdin','reg.example.com']`, `input === 'registry-pw'`, no arg contains the password.
  - `registryLogin skips without both credentials` → false, no call.
  - `registryLogin failure` → exact message and hint; message does not contain the password even when stderr echoes it (secret registered via `src/output/secrets.ts` is masked by the reporter; the function itself must not interpolate the password).
  - `pushImage tags, pushes and removes the tag` (call order), `pushImage removes the tag when the push fails`, auth hint vs reachability hint, ` Or log in first …` only without credentials.
  - `pullFromRegistry pulls, retags and removes the pulled tag`; `pullFromRegistry adds the docker setup hint on an auth error` (both variants); `pullFromRegistry fails when the target tag is missing`.
- [ ] **Step 2: Run** `npx vitest run test/unit/transfer/registry.test.ts` — Expected: FAIL (functions missing).
- [ ] **Step 3: Implement** the four functions.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(registry): local login, push and server pull`.

### Task 4: Takeover after MUP and rollback refusal

**Files:**
- Create: `templates/comet/registry-adopt.sh`
- Modify: `src/remote/ops.ts`, `src/deploy/activate.ts:190-200`, `src/deploy/pipeline.ts` (rollbackPipeline per-server callback), `PipelineDeps`
- Test: `test/unit/remote/ops.test.ts`, `test/unit/deploy/activate.test.ts`, `test/unit/deploy/pipeline.test.ts` (rollback section) or `test/unit/deploy/rollback.test.ts`

**Interfaces:**
- Produces:
  - `startShPullsRegistry(conn: SshConnection, appName: string): Promise<boolean>` — true only when the remote command prints the marker `pulls-registry` (fingerprint grep on `/opt/<app>/config/start.sh`, missing file → false).
  - `adoptMupRegistryImage(conn: SshConnection, o: { appName: string; container: string; repo: string }): Promise<boolean>` — runs `registry-adopt.sh`: when the fingerprint matches and the container exists, `sudo docker tag <container image id> <repo>:latest` and prints `adopted`; true only on that marker. Script failure → CometError with the output.
  - `PipelineDeps.startShPullsRegistry: typeof startShPullsRegistry`.
- Consumes: `cometScript`, `shq`, `appDir`, `containerName`, `localImageRepo`.

- [ ] **Step 1: Write the failing tests:**
  - ops: `startShPullsRegistry` true on marker, false on `''`; `adoptMupRegistryImage` script contains the fingerprint regex, `docker inspect`, `docker tag … 'mup-myapp:latest'`; returns true only on `adopted`.
  - activate: modes `deploy` and `reconfig` call the adopt script before `snapshot` and `retag` (order of fake conn calls); mode `rollback` does not; `takeover happens before the retag, so a failed deploy restores the adopted :latest` (the retag script runs after the adopt script, so its captured tags are post-takeover).
  - rollback pipeline: with `startShPullsRegistry` answering true for `one`, `one` gets `status: 'failed'` with the exact refusal text, `activateServer` is not called for it and the strategy skips `two`.
- [ ] **Step 2: Run** `npx vitest run test/unit/remote/ops.test.ts test/unit/deploy/activate.test.ts test/unit/deploy/pipeline.test.ts test/unit/deploy/rollback.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the template, the two ops functions, the call in `activateServer` (after rendering, before `snapshotConfig`; a verbose line `adopted the image MUP runs as :latest` when true), and the refusal in `rollbackPipeline` (decided before `through`, like `target.kind === 'none'`).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(registry): take over servers MUP deployed with a registry`.

### Task 5: Distribution, preflight and pipeline wiring

**Files:**
- Modify: `src/deploy/distribution.ts`, `src/deploy/preflight.ts:214-235`, `src/deploy/pipeline.ts` (DEFAULT_DEPS, deployPipeline, remove `assertPhase1Supported` and its four calls)
- Test: `test/unit/deploy/pipeline.test.ts`, `test/unit/deploy/preflight.test.ts`

**Interfaces:**
- Consumes: Task 1 `usesRegistry`, `registryRepo`, `assertRegistryPushable`; Task 3 `registryLogin`, `pushImage`, `pullFromRegistry`.
- Produces:
  - `DistributionDeps` gains `pushImage: typeof pushImage; pullFromRegistry: typeof pullFromRegistry`.
  - `PipelineDeps` gains `registryLogin`, `pushImage`, `pullFromRegistry` (DEFAULT_DEPS wires the real ones).
  - `registryRef(c, b: BuiltImage, multi: boolean): string` in registry.ts — `<registryRepo>:<version>` or `:<version>-<arch>`.

- [ ] **Step 1: Write the failing tests** (pipeline `setup` with `extra: "privateDockerRegistry: { host: 'reg.example.com', imagePrefix: 'reg.example.com/team', username: 'u', password: 'registry-pw' },"`, fakes recording `login`, `push:<ref>`, `pull:<server>:<ref>`, `push-latest:<ref>`):
  - `registry deploy: login after preflight and before the build, then push, then pulls, no local registry, no forwarding`: calls contain `preflight`, `login`, `build`, `push:reg.example.com/team/mup-myapp:20261107-183005`, `pull:one:…`, `pull:two:…` in that order; no `registry`, `stop-registry`, `save:`.
  - `skips the pull on a server that has the version` and `pushes nothing when every server has it`.
  - `two platforms push one ref per architecture`: refs `…:20261107-183005-amd64` and `…-arm64`; each server pulls the ref of its platform with target `mup-myapp:20261107-183005`.
  - `registry pull failure stops before activation` (no `activate:`; error `Image distribution failed:`).
  - `:latest`: pushed as `reg.example.com/team/mup-myapp:latest` after a healthy deploy; not pushed with `--servers one`; `pushes :latest when --servers names every app server`; not pushed when a server reverted; not pushed for `meteor push` (`stopAfter: 'push'`); not pushed for two platforms (info line says why); a failing push only warns and the outcome stays ok.
  - `meteor build with a registry does not log in or check imagePrefix`; `deploy without imagePrefix fails before preflight` (no `preflight` call).
  - preflight: with a registry, `probeForwarding` is not called and `streamServers` is empty.
  - Server status line `ok <duration> (from reg.example.com)`.
- [ ] **Step 2: Run** `npx vitest run test/unit/deploy/pipeline.test.ts test/unit/deploy/preflight.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement:**
  - `distributeImages`: when `usesRegistry(c)`, every server is a registry server: version check per server (as for stream), one `pushImage` per platform still needed (info line `registry: pushed <ref> in <dur>`), `checkAbort`, parallel `pullFromRegistry`; tunnel and stream paths unchanged otherwise.
  - preflight: skip `probeForwarding` and stream decisions when `usesRegistry`.
  - deployPipeline: `assertRegistryPushable` first unless `stopAfter === 'build'`; `registryLogin` after preflight and before the build (info `registry: logged in to <host>` when true); after `reportOutcome`, the `:latest` push per Global Constraints via `pushImage` with ref `<registryRepo>:latest`, an info line when skipped and why, `r.warn('The deploy succeeded, but pushing <ref> failed: <message>. Only MUP reads this tag: "mup reconfig" would run the previous version.')` on failure.
  - Delete `assertPhase1Supported` and its calls.
- [ ] **Step 4: Run** the same command plus `npx vitest run test/unit/deploy` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(registry): distribute through the private registry`.

### Task 6: Test harness: registry and forwarding on fake servers

**Files:**
- Modify: `test/harness/fake-server/Dockerfile` (add `socat`), `test/harness/fake-servers.ts` (`IMAGE_REVISION = 4`)
- Create: `test/harness/registry.ts`

**Interfaces:**
- Produces:
  - `startTestRegistry(): Promise<TestRegistry>` with `TestRegistry = { port: number; host: string /* 127.0.0.1:<port> */; ip: string; username: string; password: string; tags(repo: string): Promise<string[]>; stop(): Promise<void> }` — `registry:2.8.3` with htpasswd (bcrypt hash of the fixed test password committed in the file), published on `127.0.0.1::5000`.
  - `forwardRegistry(server: FakeServer, reg: TestRegistry): Promise<void>` — `socat TCP-LISTEN:<port>,bind=127.0.0.1,fork,reuseaddr TCP:<reg.ip>:5000` started detached inside the fake server.
  - `isolatedDockerConfig(): Promise<{ env: Record<string,string>; restore(): void }>` — temp `DOCKER_CONFIG` with a `cli-plugins` symlink to `~/.docker/cli-plugins` when it exists, and `DOCKER_HOST` from `docker context inspect --format '{{.Endpoints.docker.Host}}'`; applies to `process.env`, `restore` puts the old values back.

- [ ] **Step 1: Spike by hand** (light, no test run): start `registry:2.8.3` with htpasswd on `127.0.0.1`, `docker login --password-stdin` to it over HTTP with a temp `DOCKER_CONFIG`. If login over HTTP is refused, add a self-signed TLS cert to the harness (Docker skips verification for `127.0.0.0/8`). Record the outcome as a ledger ruling.
- [ ] **Step 2: Implement** the harness module and the Dockerfile/revision change.
- [ ] **Step 3: Run** `npx eslint test/harness` — Expected: clean. (The harness runs with the integration tests at the end.)
- [ ] **Step 4: Commit** `test(harness): private registry for the fake servers`.

### Task 7: Integration tests

**Files:**
- Create: `test/integration/registry.test.ts`, `test/integration/registry-interop.test.ts`
- Modify: `test/integration/helpers.ts` (`writeTestConfig` option `privateDockerRegistry?: Record<string, unknown>`)

**Interfaces:**
- Consumes: Task 6 harness; `cli`, `mup`, `curlApp`, `imageId`, `writeTestConfig`, `sampleProject`.

- [ ] **Step 1: Write `registry.test.ts`** (two fake servers forwarded to the registry, isolated docker config, `imagePrefix: '<host>/comet'`):
  1. `setup`, then `docker logout <host>` on s2: `deploy` fails with `Image distribution failed` and the `docker setup` hint; no app container on either server.
  2. `docker setup`, `deploy`: both servers serve the app; each server lists only `mup-sampleapp` tags (`docker images --format '{{.Repository}}'` has no `<host>/comet/…`); the registry lists the version and `latest`; no local `<host>/comet/mup-sampleapp` tag; the isolated docker config has an `auths` entry for the host.
  3. second `deploy`, then `rollback --servers s1`: s1 runs the first version, s2 the second.
- [ ] **Step 2: Write `registry-interop.test.ts`** (one server, the sequence of spec §6 (a)-(c)): `mup setup` + `mup deploy` (M1); comet `deploy` (`:previous` = M1 image); `mup reconfig` → the container runs comet's image; comet `rollback` → exit ≠ 0 with the refusal text, container unchanged; comet `reconfig` → still comet's version; comet `rollback` → M1 runs; `mup deploy` (M2); comet `deploy`; comet `rollback` → M2 runs.
- [ ] **Step 3: Run** `npx eslint test/integration` — Expected: clean. (Both files run in the final verification.)
- [ ] **Step 4: Commit** `test(registry): deploy and MUP interop through a private registry`.

### Task 8: Documentation

**Files:**
- Modify: `docs/configuration.md`, `docs/how-it-works.md`, `docs/migrating-from-mup.md`, `docs/troubleshooting.md`, `docs/commands.md`, `docs/ci.md`, `README.md`

- [ ] **Step 1: Write** the changes of spec §7: `privateDockerRegistry` section (keys, `imagePrefix` rule with examples, login side effect, refs pushed, `:latest` rule, no registry cleanup), `transfer` table (§4.2), remove the phase 2 rows; Distribute in registry mode and the start.sh difference; migration row, takeover, alternating with MUP, rollback refusal, `restart` with MUP's start.sh; troubleshooting entries (login failed, push denied, pull unauthorized → `docker setup`, `x509` / `insecure-registries`); `docker setup` logs in; CI credentials; README status, limitations, roadmap.
- [ ] **Step 2: Run** `grep -rn "phase 2" docs README.md | grep -i registry` — Expected: no line.
- [ ] **Step 3: Commit** `docs: private registry transfer`.

### Final verification (after Task 8)

- [ ] `npm run lint`, `npm run typecheck`, `npm run build`, `npm test` — all clean.
- [ ] Every integration file one at a time (`$SP/run-integ.sh`), including the two new ones — all pass.
- [ ] Final review per executing-plans, one fix pass.
