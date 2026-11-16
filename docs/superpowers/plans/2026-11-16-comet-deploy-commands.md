# ssh, meteor debug, full status, cache prune — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the phase 2 placeholders `ssh` and `meteor debug` with working commands, give `status` MUP's full report (without env values), and add `cache prune` for the local build state.

**Architecture:** Two small additions to `SshConnection` (`shell`, `forwardOut`, `openExec`) carry `ssh` and `meteor debug`. A shared server picker serves both. Debug runs a socat helper container in the app's network namespace and a local listener on 127.0.0.1. `status.sh` prints more `key=value` lines (env names are cut on the server, values never leave it). `cache prune` is a pure planner over `state.json` + `docker images` plus an executor.

**Tech Stack:** TypeScript (Node ≥ 20), ssh2, yargs, vitest, bash templates (`templates/comet/*.sh`, `@zodern/ejs`, `q()` quoting), Docker CLI.

**Spec:** `docs/superpowers/specs/2026-11-16-comet-deploy-commands-design.md`

## Global Constraints

- No value of an environment variable may appear in `status` output; env names only, cut on the server.
- Debug: nothing published on the server; local listener on `127.0.0.1` only; default local port `9229`; helper image `alpine/socat:1.8.1.1`; helper name `<app>-debug`; in-namespace port `9228`; socat `range=<gateway>/32`.
- `ssh` and `meteor debug` take no lock and write no history.
- Runner keys: `default.ssh`, `meteor.debug`, existing `default.status`/`meteor.status`.
- `status --overview` output is byte-for-byte today's `status` output.
- `cache prune` touches only entries/tags of `localImageRepo(config)` (`mup-<app.name>`), keeps the newest entry per platform unless `--all`; `docker rmi` without `--force`.
- Error texts exactly as in the spec (§4.1, §4.3, §4.5).
- Docs and commits in English; no mention of private servers.

## Review Focus

1. `ssh one -- docker ps -a`: an option-like word after `--` must reach the server unchanged, not be eaten by yargs (Task 2 test `passes option-like words after -- through`).
2. Ctrl+C while a DevTools connection is open: the helper container must still be removed and the local port freed (Task 3 test `removes the helper when aborted with an open connection`).
3. A container env value that looks like a key line (`X=a\nhttp=999`) must not inject a fake `http=` or any value into status (Task 4 test `env names are cut on the server and a value cannot inject keys`).
4. Two configs with the same `app.path` (staging, production): `cache prune` of one leaves the other's entries and images (Task 5 test `leaves entries of another repo`).
5. Local port already in use: debug fails before it changes anything on the server (Task 3 test `checks the local port before it touches the server`).

---

### Task 1: SSH layer: shell, forwardOut, openExec

**Files:**
- Modify: `src/ssh/connection.ts`, `src/ssh/interactive.ts`
- Test: `test/unit/ssh/connection.test.ts`, `test/unit/ssh/interactive.test.ts`

**Interfaces:**
- Produces:
  - `SshConnection.shell(o: InteractiveOptions): Promise<number>` — `client.shell(pty ? {rows, cols, term} : false, cb)`, same stream wiring and exit-status resolution as `interactive`.
  - `SshConnection.forwardOut(host: string, port: number): Promise<Duplex>` — `client.forwardOut('127.0.0.1', 0, host, port, cb)`; rejects with `ForwardRefusedError` when the message matches `/administratively prohibited|forwarding.*(denied|disabled)/i`, else `CometError`.
  - `export class ForwardRefusedError extends CometError` in `src/ssh/connection.ts`.
  - `SshConnection.openExec(command: string): Promise<Duplex & { stderr: Readable; exitCode: Promise<number> }>` — exec channel without pty, stream returned as is.
  - `runInteractive(conn, command: ((tty: boolean) => string) | null, term?)` — `null` calls `conn.shell`.

- [ ] **Step 1: Write the failing tests** against the in-process ssh2 `Server` already used in `connection.test.ts`:
  - `shell() opens a shell channel and resolves with its exit status` (server side: on `shell` accept, write `hi`, exit 3 → resolves 3, stdout got `hi`);
  - `forwardOut() returns a stream to the target` (server answers `tcpip` with an echo);
  - `forwardOut() rejects with ForwardRefusedError when the server refuses` (server `reject()` on `tcpip` → ssh2 reports "administratively prohibited"; assert `instanceof ForwardRefusedError`);
  - `openExec() exposes stdin/stdout and the exit code` (server exec echoes stdin, exits 0).
  - In `interactive.test.ts`: `runInteractive with null command calls shell() and restores raw mode` (fake conn with `shell` spy).
- [ ] **Step 2: Run** `npx vitest run test/unit/ssh` — Expected: FAIL (`shell is not a function` etc.).
- [ ] **Step 3: Implement** the four members and the `null` branch, following `interactive`/`forwardIn` (use `this.call(...)` and `this.closedError` for dropped connections).
- [ ] **Step 4: Run** `npx vitest run test/unit/ssh` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ssh): shell, forwardOut and openExec`.

### Task 2: Server picker and `ssh`

**Files:**
- Create: `src/cli/pick-server.ts`, `src/cli/commands/ssh.ts`
- Modify: `src/cli/commands/phase2.ts` (drop the `ssh` placeholder), `src/cli/main.ts` (register `sshCommand`)
- Test: `test/unit/cli/pick-server.test.ts`, `test/unit/cli/ssh.test.ts`, `test/unit/cli/main.test.ts` (placeholder test keeps only `meteor debug`)

**Interfaces:**
- Consumes: `runInteractive` (Task 1).
- Produces:
  - `pickServer(o: { words: string[]; candidates: string[]; usage: string; wordsMayBeCommand: boolean }): { server: string; rest: string[] }` — throws `CometError` `Choose a server: ${usage}. Servers: ${candidates.join(', ')}` or `Unknown server "${w}". Servers: ${…}` (spec §4.1).
  - `commandWords(argv: Record<string, unknown>, commandName: string): string[]` — the positional words after the command name, including words after `--`, in typed order.
  - `sshCommand: ConfigCommand` with `command: 'ssh [words..]'`, `strict: false`, describe `Open a shell on a server, or run a command there`.

- [ ] **Step 1: Write the failing tests:**
  - pick-server: `first word that is a server picks it` (`['two','ls']`, candidates `['one','two']` → `{server:'two', rest:['ls']}`); `no words and one candidate`; `no words and two candidates throws Choose a server`; `unknown first word with one candidate is part of the command when wordsMayBeCommand` (`['uptime']` → `{server:'one', rest:['uptime']}`); `unknown first word throws Unknown server` (two candidates, or `wordsMayBeCommand:false`).
  - ssh (fake pool + fake conn recording `interactive`/`shell` calls, as `test/unit/mongo` does for `mongo shell`): `no command opens a shell`; `runs the joined command and passes its exit code` (`['ssh','one','--','docker','ps']` → `interactive('docker ps')`, conn returns 4 → `main` returns 4); `passes option-like words after -- through` (`['ssh','one','--','docker','ps','-a']` → `docker ps -a`); `--servers one with a bare command` (`['ssh','--servers','one','--','uptime']`); `candidates are all servers of the config, filtered by --servers`.
  - main.test: placeholder test loops over `[['meteor','debug']]` only.
- [ ] **Step 2: Run** `npx vitest run test/unit/cli` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** Candidates: `Object.keys(ctx.config.servers)` filtered by `ctx.serverFilter`. Run under `ctx.runner.run('default.ssh', …)`. A non-zero exit throws `CometError(\`"${cmd}" exited with code ${code} on "${server}".\`, { exitCode: code })`; for the shell `The shell on "${server}" exited with code ${code}.`. If yargs consumes words after `--` into an option, read them from `argv['--']` (enable `'populate--'` in the builder only); the test decides.
- [ ] **Step 4: Run** `npx vitest run test/unit/cli` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): ssh into a server or run a command there`.

### Task 3: `meteor debug`

**Files:**
- Create: `templates/comet/debug-start.sh`, `templates/comet/debug-stop.sh`, `src/remote/debug.ts`, `src/cli/commands/debug.ts`
- Delete: `src/cli/commands/phase2.ts`; remove the placeholder test from `test/unit/cli/main.test.ts`
- Modify: `src/cli/main.ts`
- Test: `test/unit/remote/debug-script.test.ts` (fake `docker`/`sudo` on PATH, pattern of `bundle-adopt-script.test.ts`), `test/unit/remote/debug.test.ts`

**Interfaces:**
- Consumes: `forwardOut`, `ForwardRefusedError`, `openExec` (Task 1); `pickServer`, `commandWords` (Task 2, `wordsMayBeCommand: false`, candidates `ctx.appServers()`).
- Produces:
  - `DEBUG_IMAGE = 'alpine/socat:1.8.1.1'`, `DEBUG_PORT_IN_APP = 9228`.
  - `debug-start.sh` vars `container`, `helper`, `image`. Exit 10 = container not running (prints nothing else); exit 11 = no node process / kill failed (stderr has the reason); exit 12 = helper failed (stderr). Success stdout: `network=host` or `network=bridge` + `ip=<ip>` + `gateway=<gw>`. Steps in this order: running check, find node PID (`pidof -s node`, else first `/proc/<pid>/comm` equal to `node`), `kill -s USR1` via `docker exec`, `docker rm -f <helper>`, `docker run -d --rm` helper as spec §4.3 step 4 (bridge) or step 9 (host, `--entrypoint sleep … infinity`).
  - `debugApp(ctx: CommandContext, o: { words: string[]; port: number; signal: AbortSignal; listen?: (port: number) => Promise<net.Server> }): Promise<void>`.

- [ ] **Step 1: Write the failing tests:**
  - script: `bridge: kills USR1 in the app and starts a listening helper limited to the gateway` (fake inspect returns state running, networks `bridge`, ip `172.18.0.5`, gateway `172.18.0.1`; calls contain `run -d --rm --name myapp-debug --network container:myapp alpine/socat:1.8.1.1 TCP-LISTEN:9228,fork,reuseaddr,range=172.18.0.1/32 TCP:127.0.0.1:9229`; stdout `network=bridge\nip=172.18.0.5\ngateway=172.18.0.1`); `host network: the helper only sleeps`; `not running exits 10 before anything else`; `no node process exits 11`.
  - debug.ts (fake ctx/conn, `listen` injected on port 0): `checks the local port before it touches the server` (listen rejects EADDRINUSE → error `Port 9229 is in use on this computer.` with the spec hint, conn saw no script); `prints the spec's instructions with the real port`; `a connection goes through forwardOut to ip:9228` (bridge) and `to 127.0.0.1:9229` (host); `switches to docker exec once forwarding is refused, and says so once` (two connections, one warning, `openExec('sudo docker exec -i myapp-debug socat STDIO TCP:127.0.0.1:9229')`); `removes the helper when aborted with an open connection` (abort → `debug-stop.sh` ran, listener closed, resolves); `removes the helper after a failed start` (exit 12 → stop script still ran); `reports a replaced container` (forwardOut fails with a non-refused error, helper check says not running → rejects with spec §4.3 step 10 text); exit codes 10/11 map to spec texts.
- [ ] **Step 2: Run** `npx vitest run test/unit/remote/debug-script.test.ts test/unit/remote/debug.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Order in `debugApp`: pick server, `listen(port)` on `127.0.0.1` (default `net.createServer().listen`), then `debug-start.sh` via `runScript`, then serve until `signal` aborts or a fatal error; `finally` closes sockets and listener and runs `debug-stop.sh` (`sudo docker rm -f <helper>`; failure → `reporter.warn`). Helper liveness check: `sudo docker inspect -f '{{.State.Running}}' <helper>`. CLI: `meteor debug [words..]`, group `meteor`, option `--port` (number, default 9229), `strict: false`; runner key `meteor.debug`; `signal` from a local `AbortController` aborted by the first SIGINT/SIGTERM (handlers removed after), exit 0.
- [ ] **Step 4: Run** the two test files and `npx vitest run test/unit/cli` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): meteor debug through a socat helper, without a published port`.

### Task 4: Full `status` report

**Files:**
- Modify: `templates/comet/status.sh`, `src/cli/commands/status.ts`
- Create: `src/output/status-report.ts` (formatting), `src/remote/http-check.ts` (local HTTP check)
- Test: `test/unit/cli/status.test.ts`, `test/unit/output/status-report.test.ts`, `test/unit/remote/status-script.test.ts`

**Interfaces:**
- Produces:
  - status.sh new keys, always printed: `os=<PRETTY_NAME>`, `arch=<uname -m>`, `dockerfree=<KiB free in DockerRootDir>`, and for an existing container `started=<.State.StartedAt>`, `restarts=<.RestartCount>`, `network=host|bridge`, `port=<HostIp>:<HostPort> -> <port/proto>` (repeated), `envname=<NAME>` (repeated, `cut -d= -f1` on the server, names that are not `[A-Za-z_][A-Za-z0-9_]*` dropped), `httpurl=<the URL curl used>`.
  - `StatusRow` gains `details: ServerDetails` (`os`, `arch`, `dockerFreeKb: number|null`, `startedAt: string|null`, `restarts: number|null`, `ports: string[]`, `envNames: string[]`, `previousVersion: string|null`, `httpUrl: string|null`, `foreignVersion: boolean`).
  - `checkFromHere(url: string, timeoutMs = 5000): Promise<string>` — HTTP status as string, or `timeout`, `connection refused`, `DNS lookup failed`, `TLS error`, else the error code; `redirect: 'manual'`.
  - `formatStatusReport(rows: StatusRow[], fromHere: Map<string, string>, rootUrlOf: (server: string) => string, path: string, now: Date): string`.
  - `dockerVersionWarning(rows: StatusRow[]): string | null` — spec §4.4 text.

- [ ] **Step 1: Write the failing tests:**
  - status-script (fake docker): `prints names but not values of the container env` (env `MONGO_URL=mongodb://u:secret@h/db`, `X=a` + newline + `http=999`; stdout has `envname=MONGO_URL`, `envname=X`, no `secret`, exactly one `http=` line); `prints ports, started, restarts, network`.
  - status.test: `parseStatus reads the details`; `--overview prints exactly the old output` (snapshot of today's `status` output for a fixed fake run, taken before the change); `status without --overview adds one section per server and the Docker warning`.
  - status-report: `formats the spec example` (fixed rows, `now`, local results → the §4.4 block lines); `env values never appear` (row built from a parse of a stdout with values → output has no value); `foreign :latest says MUP deployed it`; `unreachable server gets one line`; `one local check per distinct URL` (two servers with the same ROOT_URL → `checkFromHere` called once).
  - http-check: against a local `http.createServer` returning 503 → `'503'`; closed port → `'connection refused'`; non-routable/slow → `'timeout'` with a 100 ms timeout.
- [ ] **Step 2: Run** `npx vitest run test/unit/cli/status.test.ts test/unit/output/status-report.test.ts test/unit/remote/status-script.test.ts test/unit/remote/http-check.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Take the overview snapshot first. `status` = table, then (without `--overview`) the Docker warning, the report, then mongo/proxy as today (`showMongoStatus(ctx, overview)`). Local checks run in parallel with a 5 s timeout; URL = effective `ROOT_URL` of the server (`app.servers[s].env.ROOT_URL ?? app.env.ROOT_URL`) + `cometDeploy.healthCheck.path`, joined without a double slash.
- [ ] **Step 4: Run** the same files — Expected: PASS.
- [ ] **Step 5: Commit** `feat(status): full report like MUP, env names without values`.

### Task 5: `cache prune`

**Files:**
- Create: `src/build/prune.ts`, `src/cli/commands/cache.ts`
- Modify: `src/build/cache.ts`, `src/transfer/local-registry.ts`, `src/cli/registry.ts` (group `cache`, description `Local build cache commands`), `src/cli/main.ts`
- Test: `test/unit/build/prune.test.ts`, `test/unit/build/cache.test.ts`, `test/unit/transfer/local-registry.test.ts`

**Interfaces:**
- Produces:
  - `BuildCache.entries(): CacheEntry[]`; `BuildCache.remove(pred: (e: CacheEntry) => boolean): CacheEntry[]` (atomic write as `save`; deletes `state.json` when nothing is left).
  - `planPrune(o: { entries: CacheEntry[]; repo: string; refs: string[]; all: boolean }): { removeRefs: string[]; removeEntries: CacheEntry[]; keep: CacheEntry[]; untouched: string[] }` — pure; `refs` are `repository:tag` from `docker images`; a ref belongs to the repo when its repository is `repo` or ends with `/${repo}`; version tags match `VERSION_RE` after stripping `-amd64`/`-arm64`; an unrecorded version ref is removed when its first 15 chars sort before the oldest kept entry's version (or always with `all`).
  - `buildDirTargets(app: { buildLocation: string; cleanBuildLocation?: boolean }, platforms: string[]): string[]` — whole dirs (with `-amd64`/`-arm64` variants) when `cleanBuildLocation`, else `bundle`, `bundle.tar.gz`, `.dockerignore` inside them.
  - `removeLocalRegistry(env?: RegistryEnv): Promise<{ removed: true } | { removed: false; pid: number }>` under `withLeaseLock`.
  - `cacheCommand` (`prune`, group `cache`) with `--all`, `--registry`, `--dry-run`.

- [ ] **Step 1: Write the failing tests:**
  - prune: `keeps the newest entry per platform`; `leaves entries of another repo` (two repos in one entries list; `--all` removes only its own); `removes unrecorded version refs older than the oldest kept entry, keeps newer ones and non-versions` (refs `mup-a:20261101-…` removed, `mup-a:20261120-…` kept, `mup-a:latest` untouched, `127.0.0.1:5000/mup-a:20261101-…` removed); `--all removes every version ref of the repo`; `buildDirTargets` with and without `cleanBuildLocation` (a stranger file `notes.txt` is never a target).
  - cache.test: `remove() rewrites state.json and deletes it when empty`.
  - local-registry: `removeLocalRegistry refuses while a live lease exists` (returns that pid, docker never called); `removes container and volume when only dead leases exist`.
  - cli (fake docker via `test/helpers/fake-docker.ts`): `--dry-run removes nothing`; `rmi refused prints a warning and keeps the entry`; output ends with the registry hint when `--registry` is not given.
- [ ] **Step 2: Run** `npx vitest run test/unit/build test/unit/transfer/local-registry.test.ts test/unit/cli` — Expected: FAIL.
- [ ] **Step 3: Implement.** Executor in `src/build/prune.ts`: `pruneCache(ctx: CommandContext, o: { all: boolean; registry: boolean; dryRun: boolean }): Promise<void>`. List refs with `docker images --format '{{.Repository}}:{{.Tag}}'`. Remove entries only for refs `docker rmi` accepted. Sizes: directories by walking them; registry volume size from `docker system df -v` (unknown → leave the size out).
- [ ] **Step 4: Run** the same files — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): cache prune for local images, the build directory and the registry`.

### Task 6: Integration tests

**Files:**
- Create: `test/integration/commands.test.ts`, `test/integration/cache-prune.test.ts`

**Interfaces:**
- Consumes: everything above; `startFakeServers(2, …)` twice (one server with `allowTcpForwarding: false`, `namePrefix: 'n'`), `sampleProject`, `writeTestConfig`, `cli`.

- [ ] **Step 1: Write the tests:**
  - commands: deploy the sample app to `s1` and `n1`; `ssh s1 -- echo hi` → output contains `hi`, code 0; `ssh s1 -- false` → code 1; `status` → section for each server with the version, `Env:` with `ROOT_URL` and no value of `env` from the config; `status --overview` has no `== s1` section; debug via `debugApp` with an `AbortController` on both servers: `GET http://127.0.0.1:<port>/json/version` returns JSON whose `Browser` starts with `node.js/`; for `n1` the output says forwarding is off; after abort `docker ps -a --filter name=sampleapp-debug` on the server is empty and `docker ps --format '{{.Ports}}'` shows no new published port.
  - cache-prune (local Docker only): tag `busybox:1.36` as `mup-prunetest:<v1>`, `<v2>`, `<v3>` plus `mup-prunetest:latest`, write a `state.json` with entries v2 and v3 in a temp `XDG_CACHE_HOME`; `cache prune` → v1 and v2 gone, v3 and `latest` stay; `--all` → only `latest` stays. Registry part only with `--dry-run` (do not remove the developer's real registry).
- [ ] **Step 2: Run** them at the end of the plan with the other integration files (`caffeinate -dims`, Mac on AC).
- [ ] **Step 3: Commit** `test(integration): ssh, status, meteor debug and cache prune`.

### Task 7: Documentation

**Files:**
- Modify: `docs/commands.md`, `docs/migrating-from-mup.md`, `docs/troubleshooting.md`, `README.md`

- [ ] **Step 1: Write** per spec §7: commands (`ssh`, `meteor debug` with the instruction block, `status` report and `--overview`, `cache prune` with its flags and the concurrent-deploy note), migrating rows and differences, troubleshooting entries (port in use, forwarding off, no node process, container replaced, port 9228, host network note, `cache prune` instead of the manual cleanup; BuildKit stays manual), README roadmap `**Phase 2: done.**` and no "phase 2" next to these commands.
- [ ] **Step 2: Check** `! grep -rn "planned for phase 2\|phase 2 of comet-deploy" docs/*.md README.md src` — Expected: no output.
- [ ] **Step 3: Commit** `docs: ssh, meteor debug, full status and cache prune`.
