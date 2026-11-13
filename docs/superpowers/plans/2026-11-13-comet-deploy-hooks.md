# comet-deploy hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run MUP's `hooks` section (localCommand, remoteCommand, method/function) at the same command keys and points as MUP 1.5.11, with a compatible `api` for method hooks and `--show-hook-names`.

**Architecture:** `CommandRunner` (src/core/runner.ts) stays the one place that enters MUP command keys; it now runs the hooks of each key through an executor (src/hooks/run.ts) and stops running hooks after the first failure, like MUP's `process.exit(1)`. The `api` object (src/hooks/api.ts) wraps the command context; `api.runCommand` dispatches keys to comet-deploy's steps (src/hooks/commands.ts). The commands are adjusted to MUP's key names and nesting.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, yargs, ssh2, vitest, Docker-in-Docker fake servers for integration tests.

**Spec:** `docs/superpowers/specs/2026-11-13-comet-deploy-hooks-design.md` (and the main design `docs/superpowers/specs/2026-11-07-comet-deploy-design.md` §7.4). MUP oracle: `node_modules/mup/lib/plugin-api.js`, `hooks.js`, `plugins/*/index.js`, `plugins/*/commands.js`.

## Global Constraints

- No new runtime dependencies.
- User-facing text and docs in English; docs never mention private servers, apps or IPs.
- A config without `hooks` keeps its exact output and step order (only `--show-hook-names` output changes).
- Hook names: a name with exactly one dot gets `default` inserted (`pre.deploy` → `pre.default.deploy`); handlers that meet under one name run in `Object.keys(config.hooks)` order; inside one object `localCommand` → `method` → `remoteCommand`.
- Pre hooks run right before a key's step, post hooks right after its success; after the first failure (a throw through a key, a failed hook, or a rollout result that is not ok) no further hooks run.
- localCommand: `/bin/sh -c`, cwd = config directory (`ctx.basePath`), env = process env, stdin inherited, output line by line through the reporter (masked). Failure text: `Hook "<name>" failed: "<command>" exited with code <n>.`
- remoteCommand: all servers of `config.servers` filtered by `--servers`, in parallel, no sudo; `=> output from <host>` then the output; a non-zero code or connection error only warns: `Hook "<name>": the remote command exited with code <n> on server "<s>".` / `Hook "<name>": the remote command could not run on server "<s>": <message>`.
- Line before each hook: `> Running hook <name> "<command>"` (local), `> Running hook <name> remote command "<command>"` (remote).
- `--show-hook-names`: `Hook: pre.<key>` / `Hook: post.<key>` (yellow in a TTY) and the command runs.
- Unsupported api members throw `api.<name>() is not supported by comet-deploy (it needs MUP's nodemiral sessions). Use api.runSSHCommand(server, command) or a remoteCommand hook.`; any property of the `nodemiral` argument throws `nodemiral is not available in comet-deploy. Use api.runSSHCommand(server, command) instead.`
- Commits on branch `feat/hooks`, no AI attribution in commit messages.

## Review Focus

1. A `method` hook in `pre.deploy` that sets `api.getConfig().app.env.X` (and one that replaces `api.settings` in `pre.reconfig`) → the env.list / METEOR_SETTINGS written on activation contain the change.
2. A hook that fails while the deploy lock is held (`post.meteor.prepareBundle`, `post.meteor.start`) → locks released, local registry lease dropped, history written for activated servers, exit 1.
3. Ctrl+C during a long `localCommand` → the child gets SIGINT, comet-deploy exits 130 and releases its locks.
4. `--servers one` with a remoteCommand hook → runs only on `one`; a mongo-only server in `servers` gets the remote hook too when selected.
5. `api.runCommand('default.restart')` from `post.default.deploy` (lock already released) works; from `post.meteor.start` (lock held) it fails with the lock message before trying to lock.

---

### Task 1: Hook registry and validation

**Files:**
- Create: `src/hooks/registry.ts`
- Modify: `src/config/validate.ts` (call `hookIssues`)
- Test: `test/unit/hooks/registry.test.ts`, `test/unit/config/validate.test.ts`

**Interfaces:**
- Produces:
  - `export interface HookHandler { localCommand?: string; remoteCommand?: string; method?: (api: unknown, nodemiral: unknown) => unknown }`
  - `export type HookTable = Map<string, HookHandler[]>`
  - `export function normalizeHookName(name: string): string`
  - `export function hookTable(hooks: Record<string, unknown> | undefined): HookTable` (a function value becomes `{ method }`)
  - `export const MUP_COMMAND_KEYS: readonly string[]` (the 45 `<plugin>.<export>` keys of MUP 1.5.11)
  - `export const KEYS_COMET_DOES_NOT_RUN: readonly string[]` = `default.init`, `default.validate`, `default.ssh`, `meteor.debug`, `docker.destroyCluster`, `proxy.envconfig`
  - `export const COMET_ONLY_KEYS: readonly string[]` = `default.rollback`
  - `export function hookIssues(hooks: unknown): Issue[]`

- [ ] **Step 1: Write the failing tests** (`registry.test.ts`):
  - `normalizes a name with one dot to the default plugin` (`pre.deploy` → `pre.default.deploy`, `post.meteor.start` unchanged);
  - `merges handlers under one name in Object.keys order` (`{ 'pre.deploy': a, 'pre.default.deploy': b }` → `[a, b]`; a function → `{ method: fn }`);
  - `MUP_COMMAND_KEYS matches MUP 1.5.11` (reads `node_modules/mup/lib/plugins/{default,docker,meteor,mongo,proxy}/commands.js`, collects `/^const (\w+) = exports\.\w+ = \{/m` names as `<plugin>.<name>`, compares as sets);
  - `hookIssues` cases, each asserting `{ path, message, severity }`:
    - `{ 'pre.deploy': 'x' }` → error `hooks."pre.deploy"` `must be an object with localCommand, remoteCommand or method, or a function`;
    - `{ localCommand: 1 }` → error `hooks."pre.deploy".localCommand` `must be a string` (same for `remoteCommand`); `{ method: 'x' }` → error `.method` `must be a function`;
    - `{ localCommand: 'a', foo: 1 }` → warning `hooks."pre.deploy".foo` `is an unknown property`;
    - `'deploy'` → warning `must start with "pre." or "post."`;
    - `'pre.deplyo'` → warning `does not match a command, so it never runs`;
    - `'pre.ssh'` → warning `belongs to a command comet-deploy does not run (default.ssh), so it never runs`;
    - `'pre.rollback'` and `'post.proxy.reconfigShared'` → no issue.
  - `validate.test.ts`: `reports hook problems` (a config with a bad hook gets the error from `validateConfig`).
- [ ] **Step 2: Run** `npx vitest run test/unit/hooks test/unit/config/validate.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/hooks/registry.ts` and call `issues.push(...hookIssues(raw.hooks))` in `validateConfig`. The hooks are validated from `raw` (functions are kept by `cloneDeep` anyway; `raw` keeps the user's names).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hooks): hook names, MUP's command keys and validation`.

### Task 2: The runner runs hooks

**Files:**
- Modify: `src/core/runner.ts`, `src/output/reporter.ts` (`hookName(line)`)
- Test: `test/unit/core/runner.test.ts` (rewritten), `test/unit/output/reporter.test.ts`

**Interfaces:**
- Consumes: Task 1 `HookTable`, `HookHandler`.
- Produces:
  - `export type HookExecutor = (name: string, handler: HookHandler) => Promise<void>`
  - `export class CommandRunner { readonly history: string[]; constructor(o?: { hooks?: HookTable; exec?: HookExecutor; showHookNames?: (line: string) => void }); run<T>(key: string, fn: () => Promise<T>, o?: { failed?: (result: T) => boolean }): Promise<T>; enter(key: string): Promise<void>; leave(key: string): Promise<void>; markFailed(): void; get failed(): boolean }`
  - `enter`: pushes `key` to `history`, prints `Hook: pre.<key>`, runs `pre.<key>` handlers. `leave`: prints `Hook: post.<key>`, runs `post.<key>`. Both do nothing but the history push after `failed`. A throw from a handler or from `fn` sets `failed` and propagates. `run` = `enter` → `fn` → (`failed(result)` ? `markFailed()` : `leave`).
  - `Reporter.hookName(line: string): void` — yellow line (plain without TTY).
  - `refuseHooks` is removed (callers in Task 5).

- [ ] **Step 1: Write the failing tests:**
  - `runs pre hooks, the step and post hooks in order` (executor records names; order `pre.default.deploy`, step, `post.default.deploy`);
  - `nested keys run their hooks inside the outer step`;
  - `enter and leave span a non-lexical step`;
  - `a throwing step runs no post hooks, here or outside` (inner throws inside outer → no `post.` of either; `failed` true);
  - `a failed result runs no post hooks` (`failed: (r) => !r.ok`);
  - `after a failure no hook runs, but keys are still recorded`;
  - `a failing hook fails the step before it runs` (pre handler throws → `fn` never called);
  - `prints Hook: lines for every key when showHookNames is set` (also without hooks; post line only after success);
  - `no executor call without hooks for the key`;
  - reporter: `hookName prints the line` (and colored only with `tty: true`).
- [ ] **Step 2: Run** `npx vitest run test/unit/core/runner.test.ts test/unit/output`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the old constructor call sites compiling: `new CommandRunner()` with no hooks is a plain recorder.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hooks): the command runner runs pre and post hooks`.

### Task 3: localCommand and remoteCommand

**Files:**
- Create: `src/hooks/run.ts`
- Test: `test/unit/hooks/run.test.ts`

**Interfaces:**
- Consumes: Task 2 `HookExecutor`; `CommandContext` (`basePath`, `config.servers`, `serverFilter`, `ssh`, `reporter`).
- Produces:
  - `export function hookServers(ctx: CommandContext): string[]` (`Object.keys(config.servers)` filtered by `serverFilter`, config order)
  - `export async function runLocalCommand(ctx: CommandContext, name: string, command: string, o?: { spawn?: typeof import('node:child_process').spawn }): Promise<void>`
  - `export async function runRemoteCommand(ctx: CommandContext, name: string, command: string): Promise<void>`
  - `export function createHookExecutor(ctx: CommandContext, api: () => unknown): HookExecutor` (order localCommand → method → remoteCommand; a method throw becomes `CometError('Hook "<name>" failed: <message>')`, with the stack as a verbose line)

- [ ] **Step 1: Write the failing tests:**
  - `runs a local command in the config directory and prints its output` (real `/bin/sh`: `pwd; echo out; echo err >&2`; asserts the `> Running hook` line, both lines, `pwd` = basePath);
  - `masks secrets in the hook output` (`reporter.addSecrets(['s3cret'])`, `echo s3cret` → masked);
  - `a failing local command fails with its exit code` (`exit 3` → the exact message);
  - `runs a remote command on every server, filtered by --servers` (fake pool: three servers incl. one not in `app.servers`; filter `['a','c']` → exec on a and c; `=> output from <host>` blocks);
  - `a remote command that fails only warns` (code 3 → warning text; `ssh.get` rejecting → `could not run` warning; the promise resolves);
  - `the executor runs localCommand, method and remoteCommand in that order`;
  - `a throwing method fails the hook with its message`.
- [ ] **Step 2: Run** `npx vitest run test/unit/hooks/run.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Local: `spawn('/bin/sh', ['-c', command], { cwd, env: process.env, stdio: ['inherit', 'pipe', 'pipe'] })`, both streams through `lineSplitter` into `reporter.info` (the reporter masks). Remote: `conn.exec(command, { onStdout, onStderr })` collecting the output, printed per server when it ends.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hooks): run local and remote hook commands`.

### Task 4: The `api` object for method hooks

**Files:**
- Create: `src/hooks/api.ts`
- Modify: `src/core/context.ts` (`setConfig`, `setSettings`, `getArgs` source), `src/config/load.ts` (export `parseSettingsFile` if `loadSettingsFile` does not fit `getSettingsFromPath`)
- Test: `test/unit/hooks/api.test.ts`

**Interfaces:**
- Consumes: `CommandContext`, `scrubConfig` (src/config/scrub.ts), `validateConfig`, `loadSettingsFile`, `expandTilde`, `logsPassthrough` (src/cli/commands/lifecycle.ts) with `commandPath = []` for `getArgs`.
- Produces:
  - `CommandContext.config` becomes writable; `CommandContext.setConfig(c: NormalizedConfig): void`; `CommandContext.setSettings(s: unknown): void` (later `getSettings()` returns `s`).
  - `export interface PluginApi { … }` with the members of spec §4.6 (getArgs, getBasePath, getVerbose, getOptions, getConfig, setConfig, validateConfig, scrubConfig, getSettings, settings (get/set), getSettingsFromPath, runCommand, runSSHCommand, resolvePath, hasMeteorPackage, swarmEnabled, commandHistory, base, args, config, configPath, settingsPath, verbose, program) plus the unsupported ones throwing.
  - `export function createPluginApi(ctx: CommandContext, runCommand: (key: string) => Promise<void>): PluginApi`
  - `export const NODEMIRAL_STUB: object` (Proxy; every property access throws the Global Constraints text).

- [ ] **Step 1: Write the failing tests:**
  - `getConfig returns the live config and setConfig replaces it` (mutation visible in `ctx.config`; `setConfig(x)` → `ctx.config === x`);
  - `settings set by a hook is what getSettings returns later` (`api.settings = { a: 1 }` → `ctx.getSettings()`; `api.getSettings().b = 2` → visible);
  - `getArgs drops comet-deploy's own options` (`{ _: ['logs'], tail: 50, config: 'x', verbose: true }` → `['logs', '--tail', 50]`);
  - `runSSHCommand uses the pool for a configured server and returns code, output and host`;
  - `resolvePath expands ~`; `hasMeteorPackage reads .meteor/versions of app.path`; `swarmEnabled is false`;
  - `validateConfig returns problems as strings`; `scrubConfig hides secrets`;
  - `getSettingsFromPath reads a JSON file and throws a CometError for a missing one`;
  - `unsupported members throw the comet-deploy message` (each of getSessions, getSessionsForServers, getManagerSession, runTaskList, getDockerLogs, getServerInfo, serverInfoStale, swarmInfo, dockerServiceInfo, forwardPort; `tasks.addCreateService`, `statusHelpers.StatusDisplay`);
  - `nodemiral throws on use`;
  - `commandHistory lists the keys as { name }`.
- [ ] **Step 2: Run** `npx vitest run test/unit/hooks/api.test.ts test/unit/core`. Expected: FAIL.
- [ ] **Step 3: Implement.** `runSSHCommand(server, cmd)`: find the name in `config.servers` by identity or `host`; use `ctx.ssh.get(name)`, else `SshConnection.connect('hook', server, { cwd, basePath })` and close it afterwards. `output` = stdout + stderr, `code` = exit code.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hooks): a compatible api object for method hooks`.

### Task 5: MUP's keys and nesting in every command

**Files:**
- Modify: `src/deploy/pipeline.ts`, `src/cli/commands/setup.ts`, `src/cli/commands/status.ts`, `src/cli/commands/proxy.ts`, `src/proxy/setup.ts`, `src/cli/commands/lifecycle.ts`, `src/core/context.ts` (wire runner + executor + api), `src/cli/registry.ts` (drop the show-hook-names placeholder)
- Test: `test/unit/deploy/pipeline.test.ts`, `test/unit/cli/*.test.ts`, `test/unit/proxy/*.test.ts`, `test/unit/mongo/status.test.ts`, `test/unit/cli/main.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `createContext` builds `runner = new CommandRunner({ hooks: hookTable(config.hooks), exec: createHookExecutor(ctx, () => api), showHookNames: argv['show-hook-names'] ? (l) => reporter.hookName(l) : undefined })` with `api = createPluginApi(ctx, (key) => runHookCommand(ctx, key))` (Task 6 provides `runHookCommand`; until then a stub that throws `Unknown command name`).
  - Key changes (spec §4.3): proxy keys `proxy.reconfigShared`, `proxy.leLogs`, `proxy.nginxConfig`; `status` enters `docker.status` (empty step) before `meteor.status`; `reconfig` and deploy run `meteor.envconfig` and `meteor.start` as siblings under `default.reconfig`; in deploy `meteor.push` is `enter` before the build and `leave` after the distribution; the history is written inside the `meteor.start` step right after the activation; deploy and reconfig read `ctx.getSettings()` again at the start of the `meteor.start` step; rollout steps pass `failed: (r) => !r.ok` (deploy outcome, lifecycle outcome).
  - `export function holdsLock(ctx: CommandContext): boolean` in pipeline.ts (true between a non-empty `lockServers` and its `releaseServers`, also for `withAppLock`).

- [ ] **Step 1: Write the failing tests:**
  - per command, `runner.history` equals spec §4.3 (deploy, meteor push, meteor build, reconfig, restart, start, stop, logs, status with mongo + proxy, setup with mongo + proxy, proxy setup, proxy reconfig-shared, proxy logs-le, proxy nginx-config);
  - `a pre.meteor.start hook that throws stops the deploy before activation and releases the locks`;
  - `a post.meteor.start hook that throws keeps the history of the activated servers and releases the locks` (fake deps record `appendHistory` and `releaseLock`);
  - `a post.meteor.prepareBundle hook that throws drops the registry lease`;
  - `a failed activation runs no post hooks` (unhealthy server → no `post.meteor.start`, no `post.default.deploy`);
  - `settings replaced in pre.default.reconfig reach the activation` (fake `activateServer` receives them);
  - `env set on getConfig() in pre.default.deploy reaches the activation`;
  - `holdsLock is true inside the lock and false after it`;
  - main.test.ts: `--show-hook-names prints the hook names and runs the command` (replaces the I5 placeholder test; uses a command with a fake pool, e.g. `docker ps`).
- [ ] **Step 2: Run** `npx vitest run test/unit`. Expected: FAIL on the new and the changed history cases.
- [ ] **Step 3: Implement.** Remove every `refuseHooks` call and the comments that say hooks are refused.
- [ ] **Step 4: Run** `npx vitest run test/unit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hooks): MUP's command keys and nesting in every command`.

### Task 6: `api.runCommand`

**Files:**
- Create: `src/hooks/commands.ts`
- Modify: `src/core/context.ts` (use `runHookCommand`)
- Test: `test/unit/hooks/commands.test.ts`

**Interfaces:**
- Consumes: the command modules (`src/cli/commands/*.ts`) and their `run(ctx, argv)`; Task 5 `holdsLock`.
- Produces:
  - `export const HOOK_COMMANDS: Record<string, { run: (ctx: CommandContext) => Promise<void>; locks: boolean }>` — every key of spec §4.3 that has a standalone step (top-level commands under `default.*`, the `meteor`, `docker`, `mongo`, `proxy` subcommands under their keys; argv for each = `{ _: [<cli words>] }` plus the current global options).
  - `export async function runHookCommand(ctx: CommandContext, key: string): Promise<void>`: unknown key → `CometError('Unknown command name: <key>')`; `meteor.prepareBundle`, `docker.destroyCluster` and `KEYS_COMET_DOES_NOT_RUN` → `api.runCommand("<key>") is not supported by comet-deploy.`; `locks && holdsLock(ctx)` → `api.runCommand("<key>") cannot run while comet-deploy holds the deploy lock (from a hook inside a locked step). Run it from a post.default.deploy hook instead.`; else the module's `run`.

- [ ] **Step 1: Write the failing tests:** `runs the command of a key with its hooks` (`docker.ps` → `runner.history` gets `docker.ps`, the hook of `pre.docker.ps` runs); `unknown key`; `unsupported key`; `a locking command inside a held lock is refused before locking` (no `acquireLock` call); `every MUP key comet-deploy runs has an entry` (`MUP_COMMAND_KEYS` minus `KEYS_COMET_DOES_NOT_RUN` minus `meteor.prepareBundle` ⊆ keys of `HOOK_COMMANDS`).
- [ ] **Step 2: Run** `npx vitest run test/unit/hooks`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/unit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hooks): api.runCommand runs comet-deploy's steps by key`.

### Task 7: Integration tests

**Files:**
- Create: `test/integration/hooks.test.ts`
- Modify: `test/integration/helpers.ts` (`writeTestConfig` option `hooks`, written as JS source so functions survive), `test/integration/interop.test.ts`
- Test: those files

**Interfaces:**
- Consumes: everything above; `startFakeServers`, `sampleProject`, `cli`, `mup`, `curlApp`.

- [ ] **Step 1: Write the tests:**
  - hooks.test.ts (one fake server, MongoDB off): `deploy runs the hooks of every form in MUP's order` (localCommand appends to a local file, remoteCommand appends to `/tmp/hooks.log` on the server, a method appends via `api.runSSHCommand`; keys `pre.deploy`, `pre.meteor.build`, `post.meteor.prepareBundle`, `pre.meteor.start`, `post.deploy`; the files show the expected sequence); `a method in pre.reconfig changes the settings the app gets` (`api.settings.public.hook = 'x'` → app route / `METEOR_SETTINGS` in env.list contains it); `a failing pre.meteor.start leaves the old version running and no lock`.
  - interop.test.ts: `MUP and comet-deploy enter the same hook names` — one config with `mongo` and `proxy`; for `setup`, `deploy`, `reconfig`, `restart`, `stop`, `start`, `status`: the `Hook:` lines of `mup <cmd> --show-hook-names` equal ours, except the differences listed in spec §4.3 (none expected in the names; `default.rollback` is not part of the list).
- [ ] **Step 2: Run** `npx vitest run -c vitest.integration.config.ts test/integration/hooks.test.ts test/integration/interop.test.ts > <workspace>/t7-run.txt 2>&1`. Expected: PASS (a Docker Hub DNS failure is the environment: rerun).
- [ ] **Step 3: Commit** `test(hooks): hooks on fake servers and next to MUP`.

### Task 8: Docs

**Files:**
- Modify: `docs/configuration.md` (Hooks rewritten; the Planned-for-phase-2 row), `docs/commands.md` (`--show-hook-names`), `docs/migrating-from-mup.md`, `docs/troubleshooting.md` (`## Hooks`: a failed hook, a hook that never runs, runCommand under the lock), `docs/how-it-works.md` (hooks in the pipeline), `README.md` (status, features, roadmap)
- Test: `grep` and lint

- [ ] **Step 1: Write the docs** from spec §4: the key table with nesting and the comet-deploy differences, the three forms, `api` members and unsupported ones, failure behavior, remoteCommand warnings and how to gate a deploy, `--show-hook-names`.
- [ ] **Step 2: Run** `sh -c '! grep -rn "Hooks are not supported\|hooks are planned for phase 2" docs README.md src && npm run lint'`. Expected: exit 0.
- [ ] **Step 3: Commit** `docs: hooks`.

### Task 9: Final verification

- [ ] **Step 1: Run** `npm run lint && npm run typecheck && npm run build && npx vitest run`. Expected: all pass.
- [ ] **Step 2: Run** the integration suite file by file (each file separately, leftover fake servers removed in between). Expected: all pass; network failures rerun.
- [ ] **Step 3:** Whole-branch review (executing-plans Final Review), one fix pass, finishing-a-development-branch.
