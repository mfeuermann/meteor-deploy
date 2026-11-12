# comet-deploy mongo section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A config with MUP's `mongo` section works in comet-deploy: `setup` and the `mongo` commands run MongoDB exactly as MUP 1.5.11 does, and the app commands check that it runs.

**Architecture:** MUP's mongo assets are copied byte for byte into `templates/mup/mongo/` and rendered with the same EJS. A new `src/mongo/` module holds the rendering, the pure rules (one-app-server constraint, version change), the server state reader and the commands' work; `src/cli/commands/mongo.ts` registers the commands. The app commands get the Mongo check through the existing preflight facts (`deploy`) and a new pipeline dependency (`reconfig`, `restart`, `rollback`, `start`). `mongo shell` uses a new interactive SSH helper that the later `ssh` and `meteor debug` reuse.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), yargs, ssh2, `@zodern/ejs` 2.7.x, Joi, vitest; fake servers (Docker in Docker) for integration.

**Spec:** `docs/superpowers/specs/2026-11-12-comet-deploy-mongo-design.md`

## Global Constraints

- Server state identical to MUP 1.5.11: container `mongodb`, image `mongo:<version>`, `/opt/mongodb/mongo-start-new.sh`, `mongo-start-current.sh`, `mongodb.conf`, data in `mongo.dataPath || '/var/lib/mongodb'`, replica set `meteor`.
- `templates/mup/mongo/{mongo-setup.sh,mongo-start.sh,mongo-stop.sh,templates/start.sh}` are byte-identical copies of `node_modules/mup/lib/plugins/mongo/assets/…`; the rendered `mongo-start-new.sh` is byte-identical with MUP's.
- Template variables exactly as MUP: `mongoVersion = mongo.version`, `mongoshCmd = mongo.version.split('.')[0] > 5 ? 'mongosh' : 'mongo'` (JS comparison of a string with a number, as MUP), `mongoDbDir = mongo.dataPath || '/var/lib/mongodb'`.
- comet-deploy never deletes anything under `dataPath`, and never recreates `mongodb` when its start script did not change. `deploy`, `reconfig`, `restart`, `rollback`, `start`, `stop` never touch the `mongodb` container.
- comet-deploy's own remote commands use `sudo`; the copied MUP scripts stay unchanged.
- Command keys for the runner: `mongo.setup`, `mongo.start`, `mongo.stop`, `mongo.logs`, `mongo.shell`, `mongo.status`.
- "Same machine" = same `host` and SSH port (`opts.port ?? 22`), as `uniqueHosts`.
- Option name: `--allow-mongo-version-change` (on `setup`, `mongo setup`, `mongo start`).
- Code comments, CLI output and docs in English. Docs never name the user's apps, servers or IPs.
- Commits on branch `feat/mongo`, no AI attribution lines. Per the user's CLAUDE.md, run single unit test files while working; the full unit suite, typecheck, build, integration/e2e and the review run once at the end (Task 10).

## Review Focus

1. `mongo.version` set to a tag that is not a plain version (`'7'`, `'latest'`, `'7.0-jammy'`): `releaseSeries` must return null and the guard must pass with a warning, never throw or refuse (Task 2 test `unparseable versions pass with a warning`).
2. `mongo-start-new.sh` written by `mup mongo setup` with another version than the config: `mongo start` must judge the versions in `-new` vs `-current` on the server, not the config (Task 4 test `start judges the scripts on the server, not the config`).
3. A Mongo check that cannot reach a server must report that server's connection error once, not a second "MongoDB is not running" for it (Task 7 test `an unreachable app server is reported once`).
4. `mongo shell` interrupted by an error: the local terminal must leave raw mode (Task 5 test `restores the terminal when the command fails`).
5. `setup` on a config whose mongo server is not the app's machine: Docker, app dirs and proxy still get set up and the output says why Mongo was skipped (Task 4 test `setup skips mongo with the reason and goes on with the proxy`).

---

### Task 1: MUP mongo templates and rendering

**Files:**
- Create: `templates/mup/mongo/mongo-setup.sh`, `templates/mup/mongo/mongo-start.sh`, `templates/mup/mongo/mongo-stop.sh`, `templates/mup/mongo/templates/start.sh` (copied with `cp`, not retyped)
- Create: `src/mongo/render.ts`
- Test: `test/unit/mongo/render.test.ts`

**Interfaces:**
- Produces (`src/mongo/render.ts`):
  - `export const MONGO_CONTAINER = 'mongodb'`
  - `export const MONGO_DIR = '/opt/mongodb'`
  - `export const MONGO_START_NEW = '/opt/mongodb/mongo-start-new.sh'`, `MONGO_START_CURRENT = '/opt/mongodb/mongo-start-current.sh'`
  - `export function mongoShellCommand(version: string): 'mongo' | 'mongosh'`
  - `export function mongoDataPath(mongo: Record<string, any>): string`
  - `export function renderMongoStartScript(mongo: Record<string, any>): Promise<string>` (the file uploaded to `MONGO_START_NEW`)
  - `export function renderMongoAsset(name: 'mongo-setup.sh' | 'mongo-start.sh' | 'mongo-stop.sh'): Promise<string>`
  - `export function mongoServers(c: NormalizedConfig, filter: string[] | null): string[]` (keys of `mongo.servers`, filtered by `--servers`)

- [ ] **Step 1: Copy the assets** with `cp` from `node_modules/mup/lib/plugins/mongo/assets/` (not `mongodb.conf`: MUP never sends it; the start template writes that file).
- [ ] **Step 2: Write the failing tests** in `test/unit/mongo/render.test.ts`:
  - `the copied assets are byte-identical with MUP 1.5.11`: for each of the four files, `readFileSync(templatePath('mup/mongo/' + f))` equals the MUP file (Buffer compare).
  - `renders start.sh like MUP` for `{ version: '3.4.24' }`, `{ version: '5.0.31' }`, `{ version: '6.0.13' }`, `{ version: '7.0.14', dataPath: '/srv/mongo' }`: equals `ejs.render(readFileSync(mupAssets + '/templates/start.sh', 'utf8'), { mongoVersion, mongoshCmd, mongoDbDir })` with the MUP formulas (load `@zodern/ejs` with `createRequire`, as `test/unit/proxy/render.test.ts`).
  - `mongoShellCommand`: `'3.4.24'`→`'mongo'`, `'5.0.31'`→`'mongo'`, `'6.0.13'`→`'mongosh'`, `'10.0.0'`→`'mongosh'`, `'latest'`→`'mongo'`.
  - `mongoServers` respects the filter: `{ one: {}, two: {} }` with filter `['two']` → `['two']`; no `mongo` → `[]`.
- [ ] **Step 3: Run** `npx vitest run test/unit/mongo/render.test.ts`. Expected: FAIL, module `src/mongo/render.ts` not found.
- [ ] **Step 4: Implement `src/mongo/render.ts`** with `renderTemplate` from `src/remote/render.ts`; `mongoShellCommand` keeps MUP's loose comparison (`(version.split('.')[0] as unknown as number) > 5`).
- [ ] **Step 5: Run** the test file. Expected: PASS.
- [ ] **Step 6: Commit** `feat(mongo): MUP's mongo scripts and the start script rendering`.

### Task 2: Pure rules: the one-app-server constraint, the version change, validate warnings

**Files:**
- Create: `src/mongo/rules.ts`
- Modify: `src/config/validate.ts` (the `mongo` block near line 135)
- Test: `test/unit/mongo/rules.test.ts`, `test/unit/config/validate.test.ts` (add cases)

**Interfaces:**
- Produces (`src/mongo/rules.ts`):
  - `export function builtInMongoProblem(c: NormalizedConfig): string | null`: null when the app has exactly one server and it is the same machine as the first `mongo.servers` key; else the reason, e.g. `MUP's built-in MongoDB needs exactly one app server (the app has 2). Use an external database: set app.env.MONGO_URL and remove the "mongo" section.` and `MUP's built-in MongoDB must run on the app's server: mongo.servers "db" is not the same machine as app server "one".`
  - `export function releaseSeries(version: string): string | null`: `'6.0.13'`→`'6.0'`, `'4.4'`→`'4.4'`, `'7'`/`'latest'`/`'7.0-jammy'`→null (only `^\d+\.\d+(\.\d+)?$`).
  - `export const MONGO_SERIES: readonly string[]` = `['3.0','3.2','3.4','3.6','4.0','4.2','4.4','5.0','6.0','7.0','8.0']` with a comment linking MongoDB's upgrade docs (one series at a time, FCV of the old series). A series after the last known one: treated as "next" only when its major is the last major + 1 (`9.0` after `8.0`); the builder documents this.
  - `export type VersionVerdict = { kind: 'same' } | { kind: 'patch' } | { kind: 'upgrade'; from: string; to: string } | { kind: 'unknown'; warning: string } | { kind: 'refuse'; reason: string }`
  - `export function judgeVersionChange(current: string | null, next: string, fcv: string | null): VersionVerdict`: `current` null → `same`; equal strings → `same`; same series → `patch`; next series with `fcv === currentSeries` → `upgrade`; next series with other or null FCV → `refuse` (reason names the FCV and the command to set it); skipped series or lower series → `refuse`; either side unparseable → `unknown`.

- [ ] **Step 1: Write the failing tests** in `test/unit/mongo/rules.test.ts`:
  - `builtInMongoProblem`: null for fixture `test/fixtures/configs/mongo` (one server); a reason containing `exactly one app server` for two app servers; a reason containing `not the same machine` when the mongo server has another host, and also when it has the same host with `opts.port: 2222` (same address, other port).
  - `judgeVersionChange` table: `(null,'7.0.14',null)`→same; `('7.0.14','7.0.14',null)`→same; `('7.0.14','7.0.15',null)`→patch; `('6.0.13','7.0.14','6.0')`→upgrade from `6.0` to `7.0`; `('6.0.13','7.0.14','5.0')`→refuse matching `/featureCompatibilityVersion is 5\.0/`; `('6.0.13','7.0.14',null)`→refuse matching `/could not read/i`; `('5.0.31','7.0.14','5.0')`→refuse matching `/one release series at a time/`; `('7.0.14','6.0.13','7.0')`→refuse matching `/older/`; `('4.4.29','5.0.31','4.4')`→upgrade; `('8.0.4','9.0.0','8.0')`→upgrade.
  - `unparseable versions pass with a warning`: `('7.0.14','latest',null)` and `('7','7.0.14',null)` → `kind: 'unknown'`, warning matching `/not checked/`.
- [ ] **Step 2: Run** `npx vitest run test/unit/mongo/rules.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `src/mongo/rules.ts`.** Same machine: `host` + `opts.port ?? 22`, as `uniqueHosts` in `src/cli/commands/setup.ts`.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Add failing validate cases** to `test/unit/config/validate.test.ts`: a config with two app servers and `mongo` gives a **warning** (not an error) at path `mongo` whose message equals `builtInMongoProblem(config)`; `mongo.servers` with two servers gives a warning `mongo.servers has 2 servers; MUP uses only the first one ("one").`
- [ ] **Step 6: Implement** the two warnings in `src/config/validate.ts` (the normalized config is available there; reuse `builtInMongoProblem`). Run `npx vitest run test/unit/config/validate.test.ts`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(mongo): rules for the built-in MongoDB and its version changes`.

### Task 3: Mongo state on a server

**Files:**
- Create: `templates/comet/mongo-state.sh`, `src/mongo/state.ts`
- Test: `test/unit/mongo/state.test.ts`

**Interfaces:**
- Produces (`src/mongo/state.ts`):
  - `export interface MongoState { setUp: boolean; newVersion: string | null; currentVersion: string | null; running: boolean; containerId: string | null; fcv: string | null }` (`setUp`: `/opt/mongodb/mongo-start-new.sh` exists; versions from the `MONGO_VERSION=` line of `-new` / `-current`; `fcv` only read when running)
  - `export function parseMongoState(stdout: string): MongoState`
  - `export async function readMongoState(conn: SshConnection): Promise<MongoState>` (runs `mongo-state.sh` via `cometScript`)
  - The script picks `mongo` or `mongosh` for the FCV query from the **running** image's version (from `-current`), with `sudo docker exec mongodb <cmd> --quiet --eval 'JSON.stringify(db.adminCommand({getParameter: 1, featureCompatibilityVersion: 1}))'`, and prints `fcv=<version>` or nothing.

- [ ] **Step 1: Write the failing tests:** `parseMongoState` on a full output (`set_up=1`, `new_version=7.0.14`, `current_version=6.0.13`, `running=1`, `container=abc123`, `fcv=6.0`) and on a fresh server (`set_up=0`, `running=0`) → all versions, id and fcv null; unknown lines ignored.
- [ ] **Step 2: Run** `npx vitest run test/unit/mongo/state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the script (key=value lines; never fails when files or the container are missing) and `src/mongo/state.ts`.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mongo): read the MongoDB state of a server`.

### Task 4: `mongo setup`, `mongo start`, `mongo stop` and `setup`

**Files:**
- Create: `src/remote/app-lock.ts` (move `withAppLock` and `ProxyLockDeps` out of `src/proxy/setup.ts`, renamed `AppLockDeps`; the proxy imports it)
- Create: `src/mongo/setup.ts`, `src/cli/commands/mongo.ts`
- Modify: `src/cli/commands/setup.ts` (`setupAll`), `src/cli/commands/phase2.ts` (drop the `mongo [command..]` placeholder), `src/cli/main.ts` (register `MONGO_COMMANDS`), `test/unit/cli/main.test.ts` (the phase-2 placeholder case no longer lists `mongo start`; use `ssh one` and `meteor debug` only)
- Test: `test/unit/mongo/setup.test.ts` (fake connections in the style of `test/unit/proxy/setup.test.ts`)

**Interfaces:**
- Consumes: Task 1 render functions, Task 2 `builtInMongoProblem` / `judgeVersionChange`, Task 3 `readMongoState`.
- Produces:
  - `src/remote/app-lock.ts`: `export type AppLockDeps = Pick<PipelineDeps, 'acquireLock' | 'releaseLock' | 'readLock'>`, `export async function withAppLock<T>(ctx: CommandContext, command: string, d: AppLockDeps, fn: () => Promise<T>): Promise<T>` (behaviour unchanged).
  - `src/mongo/setup.ts`: `export interface MongoOptions { allowVersionChange?: boolean; lockDeps?: AppLockDeps }`, `export async function mongoSetup(ctx: CommandContext, o?: MongoOptions): Promise<void>`, `export async function mongoStart(ctx: CommandContext, o?: MongoOptions): Promise<void>`, `export async function mongoStop(ctx: CommandContext, o?: MongoOptions): Promise<void>`.
  - `src/cli/commands/mongo.ts`: `export const MONGO_COMMANDS: CommandModule[]` (group `mongo`), with `setup`, `start`, `stop` here; Tasks 5 and 6 add `shell`, `logs`, `status`.

Behaviour to pin (spec §4.1, §4.2, §4.4, §4.6):
- No `mongo` section: `mongo setup` prints MUP's line `Not setting up built-in mongodb since there is no mongo config` and exits 0; `mongo start` / `stop` throw `CometError('The config has no "mongo" section.')`.
- `builtInMongoProblem` set: `mongo setup` and `mongo start` print it as a warning and do nothing else (exit 0, as MUP).
- `mongo setup`: lock → `readMongoState` → `judgeVersionChange(state.currentVersion, mongo.version, state.fcv)` → `refuse` throws before any write unless `allowVersionChange` → `mongo-setup.sh` → `writeFile(MONGO_START_NEW, renderMongoStartScript(...))`.
- `mongo start`: lock → `readMongoState` → judge `state.currentVersion` against `state.newVersion` (the script on the server) → run `mongo-start.sh` → one result line from its output and the state: `MongoDB is up to date (container kept)`, `MongoDB started` or `MongoDB recreated: the start script changed (6.0.13 → 7.0.14)`. After an `upgrade` verdict also print the FCV hint: `Before the next MongoDB upgrade, set the feature compatibility version: comet-deploy mongo shell, then db.adminCommand({ setFeatureCompatibilityVersion: "7.0", confirm: true })` (drop `, confirm: true` below 7.0).
- `mongo stop`: lock → `mongo-stop.sh` on all `mongoServers`.
- `setupAll`: `refuseHooks` gets `mongo.setup`, `mongo.start` when `config.mongo`; order `docker.setup` → `meteor.setup` → `mongo.setup` → `mongo.start` → proxy; the "not set up yet" warning goes.
- `--allow-mongo-version-change` (boolean) on `setup`, `mongo setup`, `mongo start`.

- [ ] **Step 1: Move `withAppLock`** to `src/remote/app-lock.ts`; run `npx vitest run test/unit/proxy`. Expected: PASS (pure move).
- [ ] **Step 2: Write the failing tests** in `test/unit/mongo/setup.test.ts` (labels for scripts: `mongo-setup.sh` by `sudo mkdir -p /opt/mongodb`, `mongo-start.sh` by `Please run "mup mongo setup"`, `mongo-stop.sh` by `docker update --restart=no mongodb` without `docker run`, state by a marker comment in `mongo-state.sh`, lock by `echo "acquired"`):
  - `mongo setup writes MUP's start script after the setup script`: the log is lock → state → `mongo-setup.sh` → write of `/opt/mongodb/mongo-start-new.sh` whose content equals `renderMongoStartScript` → unlock.
  - `mongo setup refuses a skipped series before writing anything` (state `current_version=5.0.31`, config `7.0.14`): rejects with `/one release series at a time/`; no `mongo-setup.sh`, no write; the lock is released.
  - `--allow-mongo-version-change writes anyway`.
  - `start judges the scripts on the server, not the config`: config `7.0.14`, state `new_version=8.0.4`, `current_version=6.0.13`, `fcv=6.0` → refuse (`6.0` → `8.0`), `mongo-start.sh` not run.
  - `start reports a kept container` (output `Same start script`, running before and after, same id) → reporter line `MongoDB is up to date (container kept)`; `start reports a recreated container` (`Different start script`, versions `6.0.13`→`7.0.14`) → line with `recreated` and both versions, and the FCV hint containing `setFeatureCompatibilityVersion: "7.0", confirm: true`.
  - `start and setup skip with the reason when the constraint fails` (two app servers): warning equal to `builtInMongoProblem`, no `mongo-start.sh`.
  - `setup skips mongo with the reason and goes on with the proxy`: fixture with `proxy` and a mongo server on another host: proxy scripts still run, a warning names the reason.
  - `setup runs mongo between the app dirs and the proxy`: `ctx.runner.history` contains `docker.setup`, `meteor.setup`, `mongo.setup`, `mongo.start`, `proxy.setup` in that order.
  - `a hook on mongo.start stops setup before Docker`: config `hooks: { 'pre.mongo.start': {...} }` → rejects before any script runs.
- [ ] **Step 3: Run** `npx vitest run test/unit/mongo/setup.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `src/mongo/setup.ts`, the three commands in `src/cli/commands/mongo.ts`, the `setupAll` change, the option, the placeholder removal and the registration in `main.ts`.
- [ ] **Step 5: Run** `npx vitest run test/unit/mongo test/unit/cli`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(mongo): mongo setup, start and stop; setup runs MongoDB like MUP`.

### Task 5: Interactive SSH and `mongo shell`

**Files:**
- Modify: `src/ssh/connection.ts` (new method)
- Create: `src/ssh/interactive.ts`
- Modify: `src/cli/commands/mongo.ts` (add `shell`)
- Test: `test/unit/ssh/connection.test.ts` (in-process ssh2 server, as the existing tests), `test/unit/ssh/interactive.test.ts`

**Interfaces:**
- Produces:
  - `SshConnection.interactive(command: string, o: { pty?: { rows: number; cols: number; term: string }; stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream; onChannel?: (resize: (rows: number, cols: number) => void) => void }): Promise<number>`: exit code (128 for a signal); with `pty` requests a pseudo-terminal and gives `onChannel` a resize function (`channel.setWindow(rows, cols, 0, 0)`).
  - `src/ssh/interactive.ts`: `export interface LocalTerminal { stdin: NodeJS.ReadStream & { isTTY?: boolean; setRawMode?(b: boolean): unknown }; stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream }` and `export async function runInteractive(conn: SshConnection, command: (tty: boolean) => string, term?: LocalTerminal): Promise<number>`: TTY when `stdin.isTTY`: raw mode on, pty with `stdout.rows/columns` and `process.env.TERM ?? 'xterm'`, follows `stdout` `resize`; always restores raw mode and removes listeners in `finally`.
  - `mongo shell`: `runInteractive(conn, (tty) => \`sudo docker exec -i${tty ? 't' : ''} mongodb ${mongoShellCommand(version)} ${shq(dbName)}\`)` on the first `mongo.servers` key; exit code = the command's; runner key `mongo.shell`.

- [ ] **Step 1: Write the failing tests:**
  - connection: `interactive pipes stdin and returns the exit code` (server `exec` handler echoes stdin, exits 3; stdin `'hello\n'` → stdout `hello\n`, resolves 3); `interactive with pty asks for a pseudo-terminal of that size` (server records the `pty` request: `rows 40, cols 120, term 'xterm-256color'`), and a resize reaches the server as a `window-change` with the new size.
  - interactive: `uses no pty when stdin is not a terminal` (command built with `tty=false`, no `setRawMode` call); `restores the terminal when the command fails` (fake TTY stdin, `conn.interactive` rejects → `setRawMode(true)` then `setRawMode(false)`, no `resize` listener left on stdout).
  - mongo command: `mongo shell runs mongosh on dbName` for fixture `mongo` (version `6.0.13`, app `my.mongo.app` → dbName `mymongoapp`): command `sudo docker exec -i mongodb mongosh mymongoapp` without a TTY.
- [ ] **Step 2: Run** `npx vitest run test/unit/ssh test/unit/mongo`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement** the method, the helper and the command.
- [ ] **Step 4: Run** the same files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mongo): mongo shell over an interactive SSH session`.

### Task 6: `mongo logs`, `mongo status` and `status`

**Files:**
- Create: `templates/comet/mongo-status.sh`, `src/mongo/status.ts`
- Modify: `src/cli/commands/mongo.ts` (add `logs`, `status`), `src/cli/commands/status.ts` (`statusCommand`)
- Test: `test/unit/mongo/status.test.ts`

**Interfaces:**
- Produces (`src/mongo/status.ts`):
  - `export interface MongoStatus { server: string; host: string; state: 'running' | 'restarting' | 'stopped' | 'missing'; restartCount: number | null; createdAt: string | null; version: string | null; connections: number | null; storageEngine: string | null; fcv: string | null; error?: string }`
  - `export function parseMongoStatus(server: string, host: string, stdout: string): MongoStatus` (the script prints the `docker inspect mongodb --format '{{json .}}'` JSON and the `serverStatus` JSON of MUP's command, plus `fcv`, each on a marked line)
  - `export function formatMongoStatus(s: MongoStatus, overview: boolean): string`: header `=> MongoDB status`; full view lines as MUP (`running on server <host>`, `Restarted <n> times`, `Running since <created>`, `Version <v>`, `Connections: <n>`, `Storage Engine: <name>`) plus `Feature compatibility: <fcv>`; overview prints only the first line; stopped or missing prints ` Stopped` as MUP.
  - `export async function showMongoStatus(ctx: CommandContext): Promise<void>` (runner key `mongo.status`, first `mongo.servers` key; an unreachable server prints its error, not a stack).
  - `mongo logs`: `streamLogs(ctx, logsPassthrough(argv, ['mongo', 'logs']), { container: MONGO_CONTAINER, servers: mongoServers(ctx.config, ctx.serverFilter) })` under key `mongo.logs`, `strict: false`.
  - `status`: `if (ctx.config.mongo) await showMongoStatus(ctx)` after the app table, before the proxy block.

- [ ] **Step 1: Write the failing tests:** `parseMongoStatus` on a captured running sample (write the sample in the test from the fields MUP reads: `State.Status`, `State.Running`, `State.Restarting`, `RestartCount`, `Created`; `version`, `connections.current`, `storageEngine.name`); on empty output → `state: 'missing'`; `formatMongoStatus` full and overview; `status runs mongo.status before proxy.status` (runner history order with fixture `mongo` plus a proxy section).
- [ ] **Step 2: Run** `npx vitest run test/unit/mongo/status.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the script, the module and the two commands.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mongo): mongo logs and mongo status; status shows MongoDB`.

### Task 7: App commands with a `mongo` section

**Files:**
- Modify: `templates/comet/facts.sh` (a `mongoName` block like `proxyName`), `src/remote/ops.ts` (`ServerFacts.mongoRunning`, `mongoSetUp`; `serverFacts(..., { proxyName, mongoName })`), `src/deploy/preflight.ts` (`runPreflight` option `mongo: boolean`, `evaluatePreflight` error), `src/deploy/pipeline.ts` (`assertPhase1Supported` drops `mongo`; new dep `checkMongo`; called in `lockedRollout` before the lock and in `startAll`)
- Create: `src/mongo/check.ts`
- Test: `test/unit/deploy/preflight.test.ts`, `test/unit/deploy/pipeline.test.ts`, `test/unit/mongo/check.test.ts`, `test/unit/remote/ops.test.ts` (parseFacts)

**Interfaces:**
- Consumes: Task 1 `MONGO_CONTAINER`, Task 2 `builtInMongoProblem`.
- Produces (`src/mongo/check.ts`):
  - `export function mongoNotRunningMessage(server: string, setUp: boolean, problem: string | null): string`: `Server "<s>": MongoDB (container "mongodb") is not running. Start it with: comet-deploy mongo start` (setUp) / `… Set it up with: comet-deploy setup` (not setUp) / `Server "<s>": MongoDB (container "mongodb") is not running. <problem>` (problem set).
  - `export async function assertMongoRunning(ctx: CommandContext, servers: string[]): Promise<void>`: no-op without `config.mongo`; one `sudo docker inspect` (running + whether `/opt/mongodb/mongo-start-new.sh` exists, the file `mongo-start.sh` needs) per server in parallel; throws one `CometError` listing every failing server; a connection error is listed as that server's error.
  - `PipelineDeps.checkMongo: typeof assertMongoRunning` (default `assertMongoRunning`).

- [ ] **Step 1: Write the failing tests:**
  - `parseFacts` reads `mongo_running=1`, `mongo_set_up=0`.
  - preflight: `stops before the build when MongoDB does not run on an app server` (input with `mongo: true`, facts `mongoRunning: false, mongoSetUp: true`) → error equal to `mongoNotRunningMessage('one', true, null)`; with `mongo: false` no error; `an unreachable app server is reported once` (facts error set) → only the connection error.
  - check: three message variants; `assertMongoRunning` lists two failing servers in one error; no `mongo` section → no SSH call.
  - pipeline: `reconfig, restart and rollback check MongoDB before the lock` (fake `checkMongo` throws → `acquireLock` never called, no server step); `start checks MongoDB before starting`; `deploy with a mongo section is no longer refused` (the old `not supported yet` assertion becomes this); `assertPhase1Supported` keeps refusing `privateDockerRegistry`.
- [ ] **Step 2: Run** `npx vitest run test/unit/deploy test/unit/mongo/check.test.ts test/unit/remote`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement.** `deploy` passes `mongo: !!ctx.config.mongo` to preflight, which asks `facts.sh` for `mongoName` on the app servers.
- [ ] **Step 4: Run** the same files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mongo): the app commands check that MongoDB runs`.

### Task 8: Integration tests on fake servers

**Files:**
- Modify: `test/integration/helpers.ts` (`sampleProject({ mongo: true })`: adds the `mongo` package to `.meteor/packages` and `server/mongo.js` with `GET /mongo/write?v=<x>` (inserts `{ v }` into collection `items`) and `GET /mongo/read` (JSON list of `v`); `writeTestConfig` option `mongo?: Record<string, unknown>`)
- Create: `test/integration/mongo.test.ts`
- Modify: `test/integration/interop.test.ts` (new `describe('interop with MUP 1.5.11 and the mongo section')`)

**Interfaces:**
- Consumes: everything above through the CLI (`cli()` helper).

Test version: `MONGO_VERSION = '7.0.14'` and patch `'7.0.15'` (images for amd64 and arm64; Meteor 3 can use them). If an image is missing for the fake servers' architecture, pick the nearest 7.0.x that has both and note the choice in the ledger.

- [ ] **Step 1: Write `test/integration/mongo.test.ts`** (one fake server, sequential `it`s):
  1. `setup starts MongoDB with the meteor replica set`: `setup` exit 0; `sudo docker inspect -f '{{.State.Running}}' mongodb` → `true`; `docker exec mongodb mongosh --quiet --eval 'rs.status().set'` → `meteor`.
  2. `a second setup keeps the container`: container id unchanged; output contains `MongoDB is up to date (container kept)`.
  3. `deploy, then the app writes and reads through MONGO_URL`: `deploy` exit 0; `/mongo/write?v=a` then `/mongo/read` contains `a`.
  4. `reconfig, restart and rollback keep the data` (deploy a second version first so rollback has a target): `/mongo/read` still contains `a` after each.
  5. `deploy and restart stop early when MongoDB is stopped`: `mongo stop`; `deploy` exits non-zero with `not running` before `Building`; `restart` exits non-zero and the app container's id is unchanged; `mongo start` → `MongoDB started`; data still there.
  6. `a patch version change recreates the container and keeps the data`: `mongo.version` → `7.0.15`, `setup` → output `recreated` with both versions; `/mongo/read` contains `a`.
  7. `an older series is refused and nothing changes`: `mongo.version` → `6.0.13`; `mongo setup` and `setup` exit non-zero with `older`; `mongo-start-new.sh` and the container id unchanged.
  8. `mongo shell, logs and status`: `echo 'db.runCommand({ping: 1}).ok' | comet-deploy mongo shell` prints `1`; `mongo logs --tail 5` exit 0 with output; `mongo status` contains `running on server` and `Version 7.0.15`; `status` contains the MongoDB block.
- [ ] **Step 2: Add the interop cases:** `mup setup` (mongo section) + `mup deploy` → our `deploy` exit 0 and the app reads/writes; our `setup` → `mup mongo start` output contains `Same start script` and the container id is unchanged; `mup setup` after our `setup` keeps the container id.
- [ ] **Step 3: Run the two new files only** (they are heavy; the full integration suite runs in Task 10): `npx vitest run -c vitest.integration.config.ts test/integration/mongo.test.ts test/integration/interop.test.ts`. Expected: PASS. Fix the code (not the expectations) on a failure, with superpowers:systematic-debugging.
- [ ] **Step 4: Commit** `test(mongo): MongoDB on fake servers and next to MUP`.

### Task 9: Documentation

**Files:**
- Modify: `docs/configuration.md` (the `mongo` section), `docs/commands.md` (the `mongo` commands, `--allow-mongo-version-change`, mongo in `setup` and `status`), `docs/migrating-from-mup.md` (drop the `mongo` row from "what does not work yet"; differences: preflight check, version guard, messages instead of silent skips, shell on `dbName`), `docs/troubleshooting.md` (MongoDB not running; a refused version change; FCV), `README.md` (features, roadmap: mongo done, status line), `docs/how-it-works.md` if it lists phase 2 gaps
- Test: none (docs); check with `grep -rn "planned for phase 2" docs README.md src | grep -i mongo` → no output.

- [ ] **Step 1: Write the docs** per spec §6: options with defaults (`version` `3.4.24` as MUP; recommend setting it, Meteor 3 needs a newer one, the builder checks the oldest MongoDB the Meteor 3 driver accepts before writing a number), the one-server constraint, the forced `MONGO_URL`, data location, upgrading one release series at a time with the FCV step, and the security note (no password; `127.0.0.1:27017`; reachable from containers on Docker's default bridge network of that server).
- [ ] **Step 2: Run** the grep above and `npm run lint`. Expected: no output; lint clean.
- [ ] **Step 3: Commit** `docs: the mongo section and commands`.

### Task 10: Final checks and review

- [ ] **Step 1: Run** `npm run lint && npm run typecheck && npm run build && npx vitest run`, then `npm run test:integration` (full integration + e2e, about 30–60 min) with output to a file in the scratchpad. Expected: all green.
- [ ] **Step 2: Whole-branch review** per superpowers:executing-plans (review package against `main`), most capable model, with this plan's Review Focus.
- [ ] **Step 3: One fix pass** for Critical/Important findings, each RED→GREEN, suite green; minors to the ledger.
- [ ] **Step 4: Report** to the user in Czech; merge and push only on their explicit request.
