# comet-deploy, fáze 1: jádro a rychlý deploy (plán implementace)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Funkční CLI `comet-deploy`, které z nezměněného `mup.js`/`mup.json` postaví image jednou lokálně, rozešle ho paralelně na servery (jen chybějící vrstvy) a aktivuje ho strategií canary s health checkem a automatickým návratem. Výsledný stav na serveru musí MUP 1.5.11 dál obsluhovat.

**Architecture:**
- **Konfigurační vrstva** (načtení, normalizace a validace MUP konfigurace) je ověřená proti samotnému MUP jako orákulu.
- **SSH vrstva** nad `ssh2` zvládá exec, SFTP a reverse tunel.
- **Lokální build** (`meteor build` → BuildKit image s cachovanou vrstvou závislostí) a **přenos** přes lokální registry a SSH tunel.
- **Pipeline** deploye (preflight → build → zámek → distribuce → aktivace → historie) renderuje původní MUP šablony.
- Příkazy jsou tenké moduly nad sdíleným `CommandContext`.

**Tech Stack:**
- Node.js ≥ 20, TypeScript 5.6+ (strict, ESM), `yargs@17`, `ssh2@1.17`, `joi@17`, `@zodern/ejs@2.7.5`, `random-seed@0.3.0`, `uuid@9`, `lodash@4`, `picocolors`.
- Testy: `vitest@2`. Build: `tsup@8`. Lint: `eslint@9` + `typescript-eslint@8`.
- Orákulum: `mup@1.5.11` jako devDependency.

**Spec:** `docs/superpowers/specs/2026-11-07-comet-deploy-design.md`. Přesné chování MUP popisuje `docs/reference/mup-1.5.11.md` (dál jen „ref.“).

**Navazující plány** (napíšou se po dokončení fáze 1):
- **Fáze 2:** proxy (všechny `proxy *` příkazy, LE, certifikáty, load balancing), Mongo, nulový výpadek, hooks + kompatibilní PluginAPI, přenos `registry` a `stream`, bundle mód, `meteor debug`, `ssh`, plný `status`, `cache prune`.
- **Fáze 3:** README a dokumentace (EN), benchmark proti MUP, GitHub Actions CI, publikace na npm.

## Global Constraints

- Balíček `comet-deploy`, binárka `comet-deploy`, sekce nových voleb v konfiguraci `cometDeploy`. Licence MIT (© 2026 Marek Feuermann). `NOTICE` uvádí MUP šablony (MIT, © 2016 Kadira Inc. a přispěvatelé Meteor Up).
- Node ≥ 20 (`engines`), `"type": "module"`, TypeScript `strict: true`.
- Kód, komentáře, testy, commity a CLI výstupy jsou anglicky. Commity nesmí obsahovat `Co-Authored-By` ani jinou AI atribuci. Pracuje se na větvi `feat/phase1-core` vytvořené z `docs/design`, nikdy na `main`. Merge a push jen na výslovný pokyn uživatele.
- **Testy (pokyn uživatele):** v každém úkolu se spouští jen jeho vlastní unit test soubor (`npx vitest run <soubor>`) a případně `npx eslint <soubory>`. Celá unit sada, `tsc --noEmit`, `tsup` build, integrační a e2e testy (Docker) a code review běží **jen v úkolu 21**.
- **Stav na serveru je identický s MUP 1.5.11 (ref. §5):**
  - kontejner `<app.name>`, adresář `/opt/<app.name>/`,
  - image `mup-<app.name.toLowerCase()>` s tagy `latest` a `previous`,
  - `start.sh` a `env.list` renderované z **kopií MUP šablon** pomocí `@zodern/ejs@2.7.5`, byte-identicky.
- **Nové artefakty na serveru jsou jen tyto:**
  - version tagy `mup-<lc>:<verze>`, kde `<verze>` odpovídá `^\d{8}-\d{6}(-[0-9a-f]{7})?(-dirty)?$`,
  - `/opt/<name>/config/deploy-history.jsonl`,
  - `/opt/<name>/config/deploy.lock/` (adresář + `info.json`),
  - `/opt/<name>/config/.prev/` (snapshot `start.sh` a `env.list`).
- **Výchozí hodnoty `cometDeploy`:**
  - `strategy: 'canary'`, `transfer: 'auto'`, `platform: 'auto'`, `keepVersions: 5`, `zeroDowntime: true`, `healthCheck: { path: '/', maxStatus: 499 }`, `lock: true`,
  - timeout health checku = `app.deployCheckWaitTime ?? 60` s,
  - port health checku = `app.deployCheckPort ?? app.docker.imagePort`.
- **Tajné hodnoty:**
  - Žádné `ARG`/`--build-arg` z `app.env` kromě klíčů, na které odkazují `docker.buildInstructions` (`$KEY` nebo `${KEY}`).
  - Hodnoty z `app.env`, `servers.*.env`, `METEOR_SETTINGS` a `servers.*.password` reporter vždy maskuje jako `***`.
- Výstup vzdálených skriptů a lokálních buildů se při `--verbose` streamuje řádek po řádku přes `reporter.verboseLine(server, line)` (lokální = `null`). Bez `--verbose` se zobrazí jen při chybě (posledních 50 řádků).
- Lokální registry: image `registry:2.8.3`, kontejner `comet-deploy-registry`, volume `comet-deploy-registry-data`, publikace jen na `127.0.0.1`.
- Produkční servery aaa-brain se nesmí použít bez výslovného svolení uživatele v danou chvíli. Testovací server poskytne uživatel v úkolu 21.
- Ve fázi 1 nejsou: proxy runtime, Mongo runtime, hooks (jen no-op body), swarm, `registry`/`stream` transport, bundle mód.
  - Když konfigurace obsahuje `proxy` nebo `mongo`, deploy skončí `CometError("... is not supported yet (planned for phase 2)")`.
  - Normalizace a validace těchto sekcí se ale implementuje už teď, protože jde o čisté funkce a ovlivňují `env.list`.

## Review Focus

1. **Speciální znaky v env a settings:** uvozovky, `$`, mezery, unicode a dlouhý `METEOR_SETTINGS` (desítky KB) musí v kontejneru dorazit beze změny. Žádný náš skript je nesmí interpolovat. Test: úkol 6 (unit, render) + úkol 20 (integrace, `docker exec printenv`).
2. **Ctrl+C nebo pád SSH uprostřed deploye:** zámek se uvolní, tunel se zavře a servery před aktivací zůstanou beze změny. Test: úkol 16, `deployPipeline` s injektovaným abortem.
3. **Jména aplikací s velkými písmeny a tečkami** (`My.App`): image je `mup-my.app`, kontejner `My.App`, adresář `/opt/My.App`. Test: úkol 4.
4. **Servery dosud nasazené jen MUPem** (bez version tagů a historie, s `:previous` i bez něj): deploy, `rollback` i `history` musí fungovat. Test: úkol 18 (výběr cíle rollbacku) a úkol 20 (interop scénář).
5. **SSH přístupy mimo výchozí:** heslo se speciálními znaky, ne-root uživatel se sudo, `opts.port`, `pem` s `~`, fallback na agenta. Test: úkol 8, `buildConnectOptions`.

---

## Struktura souborů

```
package.json, tsconfig.json, tsup.config.ts, vitest.config.ts, vitest.integration.config.ts,
eslint.config.js, LICENSE, NOTICE, .gitignore
src/
  cli/main.ts                 buildCli(), main()
  cli/registry.ts             CommandModule, registerCommands()
  cli/commands/*.ts           jeden soubor na příkaz nebo skupinu
  core/errors.ts              CometError
  core/context.ts             CommandContext, createContext()
  core/runner.ts              CommandRunner (budoucí body pro hooks)
  core/naming.ts              imageRepo(), localImageRepo(), containerName(), appDir()
  config/types.ts             RawConfig, NormalizedConfig, ServerConfig, AppConfig, CometOptions, …
  config/load.ts              findConfigFile(), loadConfigFile(), loadSettings(), resolveUserPath()
  config/deterministic.ts     lbPort(), defaultBuildLocation()
  config/normalize.ts         normalizeConfig()
  config/schema.ts            Joi schémata (port z MUP validátorů)
  config/validate.ts          validateConfig(), Issue
  config/scrub.ts             scrubConfig()
  config/servers.ts           parseServerFilter(), selectServers()
  output/reporter.ts          Reporter, createReporter(), maskSecrets()
  output/secrets.ts           collectSecrets()
  local/exec.ts               run()
  local/docker.ts             dockerInfo(), dockerBuildxPlatforms(), dockerImageId(), …
  ssh/options.ts              buildConnectOptions()
  ssh/connection.ts           SshConnection
  ssh/pool.ts                 SshPool
  remote/render.ts            renderTemplate()
  remote/app-files.ts         renderStartSh(), renderEnvList(), renderMeteorStart(), …
  remote/ops.ts               serverFacts(), lock, versions, history, snapshot, retag
  build/meteor-build.ts       meteorBuildArgs(), runMeteorBuild()
  build/node-version.ts       readNodeVersion()
  build/input-hash.ts         computeInputHash()
  build/version.ts            makeVersion(), readGitInfo()
  build/cache.ts              BuildCache
  build/dockerfile.ts         detectDepsFiles(), planBuildContext(), renderDockerfile()
  build/index.ts              buildApp()
  transfer/local-registry.ts  ensureLocalRegistry(), pushToLocalRegistry(), stopLocalRegistry()
  transfer/tunnel.ts          openReverseTunnel()
  transfer/distribute.ts      distributeToServer()
  deploy/preflight.ts         platformForArch(), evaluatePreflight(), runPreflight()
  deploy/health-check.ts      parseHealthResult(), healthCheck()
  deploy/activate.ts          activateServer(), revertServer()
  deploy/strategy.ts          runStrategy()
  deploy/history.ts           makeHistoryEntry(), mergeHistory()
  deploy/rollback.ts          chooseRollbackTarget()
  deploy/pipeline.ts          deployPipeline(), reconfigPipeline(), rollbackPipeline()
templates/mup/meteor/         kopie MUP assets: templates/start.sh, templates/env.list,
                              meteor-start.sh, meteor-stop.sh, meteor-setup.sh, meteor-destroy.sh
templates/mup/docker/         kopie MUP assets: docker-setup.sh, docker-update.sh, docker-restart.sh
                              (+ install-docker.sh, pokud ho zahrnují)
templates/mup/default/        mup.js.sample, settings.json
templates/comet/              naše skripty: facts.sh, lock-acquire.sh, lock-release.sh, versions.sh,
                              history-append.sh, snapshot.sh, restore-snapshot.sh, retag.sh,
                              health-check.sh, pull-via-tunnel.sh, destroy-extra.sh
test/unit/**                  unit testy (zrcadlí src/)
test/oracle/mup-oracle.ts     přístup k MUP 1.5.11 jako orákulu
test/fixtures/configs/**      fixture konfigurace
test/fixtures/bundles/**      malé ukázkové bundly (jen soubory potřebné pro testy)
test/fixtures/sample-app/     Meteor 3.5.4 aplikace s nativním modulem (úkol 20)
test/harness/**               falešné servery (sshd + Docker-in-Docker)
test/integration/**, test/e2e/**
```

---

### Task 1: Kostra projektu a CLI

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `vitest.integration.config.ts`, `eslint.config.js`, `LICENSE`, `NOTICE`, `src/cli/main.ts`, `src/core/errors.ts`, `bin` entry v `package.json` → `dist/cli/main.js`
- Modify: `.gitignore` (přidat `coverage/`, `.tmp/`)
- Test: `test/unit/cli/main.test.ts`

**Interfaces:**
- Produces:
  - `buildCli(argv: string[], io?: { stdout: (s: string) => void; stderr: (s: string) => void }): import('yargs').Argv`
  - `main(argv = process.argv.slice(2)): Promise<number>` (vrací exit code)
  - `class CometError extends Error { constructor(message: string, opts?: { exitCode?: number; hint?: string; cause?: unknown }) }`, výchozí `exitCode` 1

- [ ] **Step 1: Založ větev a projekt.** Spusť `git checkout -b feat/phase1-core docs/design`. Vytvoř `package.json`:
  - `name: comet-deploy`, `version: 0.1.0`, `type: module`, `engines.node: >=20`, `bin.comet-deploy: dist/cli/main.js`,
  - scripts:
    - `build`: `tsup`,
    - `test`: `vitest run`,
    - `test:integration`: `vitest run -c vitest.integration.config.ts`,
    - `typecheck`: `tsc --noEmit`,
    - `lint`: `eslint .`,
  - `files: ["dist", "templates", "LICENSE", "NOTICE"]`.

  Nainstaluj závislosti:
  - runtime: `ssh2@^1.17.0`, `yargs@^17.7.2`, `joi@^17.13.3`, `@zodern/ejs@2.7.5`, `random-seed@0.3.0`, `uuid@^9.0.1`, `lodash@^4.17.21`, `picocolors@^1.1.1`,
  - dev: `typescript@^5.6.3`, `tsup@^8.3.5`, `vitest@^2.1.8`, `eslint@^9.15.0`, `typescript-eslint@^8.15.0`, `@types/node@^20`, `@types/ssh2`, `@types/yargs`, `@types/lodash`, `mup@1.5.11`.
- [ ] **Step 2: Konfigurace.**
  - `tsconfig.json`: `target ES2022`, `module NodeNext`, `strict`, `outDir dist`, `rootDir .`.
  - `tsup`: entry `src/cli/main.ts`, format esm, shebang `#!/usr/bin/env node`.
  - `vitest.config.ts`: `include: ['test/unit/**/*.test.ts']`.
  - `vitest.integration.config.ts`: `include: ['test/integration/**/*.test.ts', 'test/e2e/**/*.test.ts']`, `testTimeout: 600_000`, `fileParallelism: false`.
- [ ] **Step 3: Write the failing test.** `test/unit/cli/main.test.ts`:
  - `main(['--version'])` vrátí `0` a stdout obsahuje `0.1.0`,
  - `main(['nonexistent-cmd'])` vrátí nenulový kód.
- [ ] **Step 4: Run test to verify it fails.** Run: `npx vitest run test/unit/cli/main.test.ts`. Expected: FAIL (modul neexistuje).
- [ ] **Step 5: Implementuj `buildCli`/`main`.**
  - yargs `.strict()`, `.version(<z package.json>)`, `.help()`, `scriptName('comet-deploy')`.
  - `main` zachytí `CometError`: vypíše `message` (+ `hint`) bez stack trace a vrátí `exitCode`. Neznámé chyby vypíše se stackem a vrátí 1.
  - `LICENSE` (MIT), `NOTICE`.
- [ ] **Step 6: Run test to verify it passes.** Run: `npx vitest run test/unit/cli/main.test.ts`. Expected: PASS.
- [ ] **Step 7: Commit.** `git add -A && git commit -m "chore: scaffold comet-deploy CLI project"`

---

### Task 2: Reporter a maskování tajných hodnot

**Files:**
- Create: `src/output/reporter.ts`, `src/output/secrets.ts`
- Test: `test/unit/output/reporter.test.ts`, `test/unit/output/secrets.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type ServerStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped' | 'reverted';
  interface SummaryRow { server: string; version?: string; result: ServerStatus; durationMs?: number; note?: string }
  interface Reporter {
    phase<T>(name: string, fn: () => Promise<T>): Promise<T>;   // měří čas, vypíše začátek/konec
    server(server: string, step: string, status: ServerStatus, detail?: string): void;
    info(msg: string): void; warn(msg: string): void; error(msg: string): void;
    verboseLine(server: string | null, line: string): void;     // jen při verbose
    summary(rows: SummaryRow[]): void;
    phaseTimings(): Array<{ name: string; durationMs: number }>;
    addSecrets(values: string[]): void;
  }
  function createReporter(opts: { verbose: boolean; tty: boolean; write?: (s: string) => void; now?: () => number }): Reporter;
  function maskSecrets(text: string, secrets: string[]): string;   // nejdelší první, prázdné a < 4 znaky ignoruje
  function collectSecrets(config: NormalizedConfig, settings?: unknown): string[];
  ```
  `NormalizedConfig` je typ z úkolu 4. Do té doby importuj typ z `src/config/types.ts`, který v tomto úkolu založ s minimální kostrou. Úkol 4 ho rozšíří.

- [ ] **Step 1: Write the failing tests.**
  - `maskSecrets('mongodb://u:p4ss@h/db and p4ss', ['p4ss', 'mongodb://u:p4ss@h/db'])` vrátí `'*** and ***'`.
  - Pro `['ab', '']` se nic nemaskuje.
  - `collectSecrets` vrátí všechny string hodnoty z `app.env`, z `app.servers.*.env` a `servers.*.password` a `JSON.stringify(settings)`. Čísla a booleany vrací jako string a vyřadí ty kratší než 4 znaky.
  - Reporter v ne-TTY módu: `phase('build', …)` zapíše řádek začínající `==> build` a po dokončení `<== build (1.2s)` (s `now` stubem).
  - `server('one','distribute','ok','4.2s')` zapíše `[one] distribute ✓ 4.2s`.
  - `summary` vypíše tabulku s hlavičkou `SERVER  VERSION  RESULT  TIME`.
  - Každý výstup prochází `maskSecrets` s registrovanými tajemstvími.
- [ ] **Step 2: Run test to verify it fails.** Run: `npx vitest run test/unit/output`. Expected: FAIL.
- [ ] **Step 3: Implementuj.** TTY mód smí přepisovat řádky (ANSI) nebo stačí stejné řádky s barvami přes `picocolors`. Ne-TTY nesmí obsahovat escape sekvence.
- [ ] **Step 4: Run test to verify it passes.** Run: `npx vitest run test/unit/output`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: add reporter with secret masking"`

---

### Task 3: Načtení konfigurace a settings

**Files:**
- Create: `src/config/load.ts`
- Test: `test/unit/config/load.test.ts`, fixtures `test/fixtures/configs/{js-only,json-only,both,custom-name,bad-json,settings-missing}/…`

**Interfaces:**
- Produces:
  ```ts
  interface LoadedConfig { configPath: string; basePath: string; raw: RawConfig }
  function findConfigFile(cwd: string, configFlag?: string): string;
  function loadConfig(cwd: string, configFlag?: string): LoadedConfig;
  function loadSettings(o: { cwd: string; basePath: string; settingsFlag?: string }): { settings: unknown; settingsPath: string };
  function loadSettingsFile(path: string): unknown;
  function resolveUserPath(p: string, o: { cwd: string; basePath: string; base: 'cwd' | 'config'; warn?: (m: string) => void }): string;
  function expandTilde(p: string): string;
  ```

- [ ] **Step 1: Write the failing tests.**
  - `findConfigFile(dir)`:
    - vrátí `<dir>/mup.js`, když existuje, i když existuje i `mup.json`,
    - jinak `<dir>/mup.json`,
    - jinak vyhodí `CometError` se zprávou obsahující `mup.js` a `comet-deploy init`.
  - `--config ./x/custom.json` se resolvuje vůči cwd a `basePath` = `dirname` té cesty. Bez flagu je `basePath` = cwd.
  - `.js` konfigurace se načte čerstvě: druhé načtení po změně souboru vrátí novou hodnotu (vyčištění require cache).
  - `.json` se syntaktickou chybou vyhodí `CometError` obsahující název souboru.
  - `loadSettings` bez flagu čte `<basePath>/settings.json`. S flagem se cesta resolvuje vůči cwd. Chybějící soubor → `CometError` s cestou. Neplatný JSON → `CometError`.
  - `resolveUserPath('k.pem', { base: 'cwd' })`: když soubor neexistuje vůči cwd, ale existuje vůči `basePath`, vrátí cestu vůči `basePath` a zavolá `warn`.
- [ ] **Step 2: Run test to verify it fails.** Run: `npx vitest run test/unit/config/load.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implementuj.**
  - JS se načítá přes `createRequire(import.meta.url)` + `delete require.cache[resolved]`.
  - JSON přes `fs.readFileSync` + `JSON.parse`.
  - Pravidla, která cesta se bere vůči cwd a která vůči adresáři konfigurace, jsou v ref. §1 (tabulka „Path resolution“).
- [ ] **Step 4: Run test to verify it passes.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: load mup.js/mup.json config and settings"`

---

### Task 4: Typy, deterministické hodnoty, normalizace a orákulum MUP

**Files:**
- Create: `src/config/types.ts` (plné typy), `src/config/deterministic.ts`, `src/config/normalize.ts`, `src/core/naming.ts`, `test/oracle/mup-oracle.ts`
- Test: `test/unit/config/deterministic.test.ts`, `test/unit/config/normalize.test.ts`, `test/unit/core/naming.test.ts`, fixtures `test/fixtures/configs/{aaa-like,per-server-env,mongo,proxy-le,proxy-lb,registry,legacy-docker-image,upper-dot-name}/mup.js` (fiktivní hodnoty, žádné reálné IP ani hesla)

**Interfaces:**
- Consumes: `LoadedConfig` (úkol 3).
- Produces:
  ```ts
  interface ServerConfig { host: string; username: string; pem?: string; password?: string; opts?: { port?: number; [k: string]: unknown }; privateIp?: string }
  interface AppServerRef { env?: Record<string, string | number | boolean>; bind?: string; settings?: string }
  interface DockerOptions { image: string; imagePort: number; args?: string[]; bind?: string; prepareBundle?: boolean; prepareBundleLocally?: boolean; buildInstructions?: string[]; stopAppDuringPrepareBundle?: boolean; useBuildKit?: boolean; networks?: string[]; imageFrontendServer?: string }
  interface BuildOptions { serverOnly?: boolean; debug?: boolean; buildLocation: string; cleanBuildLocation?: boolean; mobileSettings?: Record<string, unknown>; server?: string; allowIncompatibleUpdates?: boolean; allowIncompatibleUpdate?: boolean; executable?: string; cleanAfterBuild?: boolean }
  interface AppConfig { name: string; path: string; type: string; servers: Record<string, AppServerRef>; env: Record<string, string | number | boolean>; docker: DockerOptions; buildOptions: BuildOptions; deployCheckWaitTime?: number; deployCheckPort?: number; enableUploadProgressBar?: boolean; log?: { driver?: string; opts?: Record<string, unknown> }; volumes?: Record<string, string>; ssl?: unknown; nginx?: unknown; port?: number }
  interface CometOptions { strategy: 'canary' | 'rolling' | 'parallel'; transfer: 'auto' | 'tunnel' | 'registry' | 'stream'; platform: 'auto' | 'linux/amd64' | 'linux/arm64'; keepVersions: number; zeroDowntime: boolean; healthCheck: { path: string; maxStatus: number }; lock: boolean }
  interface NormalizedConfig { servers: Record<string, ServerConfig>; app: AppConfig; meteor?: unknown; mongo?: Record<string, any>; proxy?: Record<string, any>; privateDockerRegistry?: { host: string; imagePrefix?: string; username?: string; password?: string }; hooks?: Record<string, unknown>; plugins?: string[]; swarm?: { enabled: boolean }; cometDeploy: CometOptions }
  type RawConfig = Record<string, any>;
  function lbPort(appName: string): number;
  function defaultBuildLocation(absAppPath: string): string;          // join(os.tmpdir(), 'mup-meteor-' + uuid)
  function normalizeConfig(raw: RawConfig, o: { basePath: string }): NormalizedConfig;
  function imageRepo(c: NormalizedConfig): string;        // 'mup-<lc>' nebo '<imagePrefix>/mup-<lc>'
  function localImageRepo(c: NormalizedConfig): string;   // vždy 'mup-<lc>'
  function containerName(c: NormalizedConfig): string;    // app.name beze změny
  function appDir(c: NormalizedConfig): string;           // '/opt/' + app.name
  // test/oracle/mup-oracle.ts
  function mupNormalize(configPath: string): Promise<RawConfig>;   // MUP api.getConfig(false)
  ```

- [ ] **Step 1: Write the failing tests: deterministické hodnoty** (vektory z ref. Appendix):
  - `lbPort('app')` = 19157, `lbPort('myapp')` = 18442, `lbPort('staging')` = 11399, `lbPort('production')` = 17499, `lbPort('Wekan')` = 10318,
  - `defaultBuildLocation('/home/u/myapp')` = `join(os.tmpdir(), 'mup-meteor-b5af117c-b68e-49a5-ae1c-0877b574ddbb')`,
  - `defaultBuildLocation('/Users/me/app')` = `join(os.tmpdir(), 'mup-meteor-3eaabbe3-e2b0-497d-8456-b27d10a37804')`.
- [ ] **Step 2: Write the failing tests: normalizace vs orákulum.** Pro každou fixture platí: `normalizeConfig(raw)` bez klíče `cometDeploy` se rovná (`toEqual`) `await mupNormalize(path)` bez `_origionalConfig`. Výjimky:
  - fixture `proxy-le` s `ROOT_URL: 'http://a.com:3000'`: náš výsledek je `https://a.com:3000`, MUP vrací `https://a.com3000`. Test výslovně ověří obojí, aby byla vidět záměrná oprava.
  - Výchozí `cometDeploy` se rovná hodnotám z Global Constraints.
  - Částečné `cometDeploy: { strategy: 'rolling' }` se doplní defaulty.
  - `naming` pro `name: 'My.App'`: `imageRepo` = `mup-my.app`, `containerName` = `My.App`, `appDir` = `/opt/My.App`. S `privateDockerRegistry.imagePrefix: 'reg.io/team'` je `imageRepo` = `reg.io/team/mup-my.app` a `localImageRepo` zůstane `mup-my.app`.
- [ ] **Step 3: Run tests to verify they fail.** Run: `npx vitest run test/unit/config/deterministic.test.ts test/unit/config/normalize.test.ts test/unit/core/naming.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implementuj orákulum** `test/oracle/mup-oracle.ts`:
  - načte MUP z `node_modules/mup/lib` jeho vlastní cestou (`load-plugins` + `PluginAPI`, viz `mup/lib/index.js`),
  - zavolá `getConfig(false)` s `cwd` = adresář fixture,
  - nesmí spouštět síť (`MUP_SKIP_UPDATE_CHECK=true`).
- [ ] **Step 5: Implementuj `deterministic.ts`, `normalize.ts`, `naming.ts`.**
  - Normalizace přesně podle ref. §2.9 a `prepareConfig` v `mup/lib/plugins/{meteor,mongo,proxy}/index.js`, v pořadí meteor → mongo → proxy, včetně `meteor` → `app` aliasu a přesunu `dockerImage` → `docker.image`.
  - Oprava ROOT_URL: přepiš jen schéma (`http://` → `https://`).
  - `buildLocation` resolvuj vůči appPath až při buildu. Tady ji jen doplň jako MUP.
- [ ] **Step 6: Run tests to verify they pass.** Expected: PASS.
- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat: normalize MUP config with MUP as test oracle"`

---

### Task 5: Validace a scrub

**Files:**
- Create: `src/config/schema.ts`, `src/config/validate.ts`, `src/config/scrub.ts`
- Test: `test/unit/config/validate.test.ts`, `test/unit/config/scrub.test.ts`

**Interfaces:**
- Consumes: `NormalizedConfig`, `RawConfig` (úkol 4).
- Produces:
  ```ts
  interface Issue { path: string; message: string; severity: 'error' | 'warning' }
  function validateConfig(config: NormalizedConfig, raw: RawConfig): Issue[];
  function hasFatal(issues: Issue[]): boolean;
  function scrubConfig(config: NormalizedConfig): NormalizedConfig;   // hluboká kopie
  ```

- [ ] **Step 1: Write the failing tests.** Tabulka případů. Prefix cesty je `meteor.` nebo `app.` podle toho, který klíč je v raw konfiguraci (jako MUP).

  `severity: 'error'`:
  - chybí `app.name` / `app.path` / `servers`,
  - `name` s mezerou,
  - `env.ROOT_URL` bez `http(s)://`,
  - `app.servers.x`, který není v `servers`,
  - `swarm.enabled: true` (zpráva obsahuje `not supported`),
  - přítomné `app.ssl`, `app.nginx` nebo `app.docker.imageFrontendServer` (zpráva obsahuje `proxy`),
  - hodnota v `app.env` obsahující `\n`,
  - `cometDeploy.strategy: 'fast'`,
  - `cometDeploy.keepVersions: 0`.

  `severity: 'warning'`:
  - neznámý klíč `app.foo`,
  - `servers.one.opts.readyTimeout`,
  - `buildOptions.allowIncompatibleUpdate`,
  - `plugins: ['mup-redis']` (zpráva obsahuje `not supported`),
  - `docker.prepareBundleLocally` (zpráva `ignored: comet-deploy always builds locally`).

  Platná fixture `aaa-like` nevrací žádné issues.

  `scrubConfig` podle ref. §2.10:
  - `host` → `1.2.3.4`, `password` → `password`, `pem` → `~/.ssh/pem`, `app.name` → `my-app`,
  - `ROOT_URL` `https://sub.example.org:3000/x` → `https://subdomain.host.com:3000/x`.

  Výstup scrubu lze porovnat s orákulem: MUP `api.scrubConfig()`. Přidej to jako test pro fixture `aaa-like`.
- [ ] **Step 2: Run test to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implementuj.**
  - Joi schémata přenes z `mup/lib/plugins/*/validate.js` a `mup/lib/validate/servers.js`.
  - Klasifikace error/warning podle spec §7.1.
  - `cometDeploy` schéma vytvoř nově.
- [ ] **Step 4: Run test to verify it passes.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: validate and scrub config"`

---

### Task 6: MUP šablony a renderování souborů aplikace

**Files:**
- Create:
  - `templates/mup/**` (kopie z `node_modules/mup/lib/plugins/{meteor,docker}/assets` a `plugins/default/template`, beze změny obsahu),
  - `src/remote/render.ts`, `src/remote/app-files.ts`,
  - rozšíření `test/oracle/mup-oracle.ts` o `mupEnvconfigFiles()`.
- Test: `test/unit/remote/app-files.test.ts`

**Interfaces:**
- Consumes: `NormalizedConfig`, `imageRepo` (úkol 4), `loadSettingsFile` (úkol 3).
- Produces:
  ```ts
  function templatePath(rel: string): string;       // absolutní cesta do <package>/templates
  function renderTemplate(rel: string, vars: Record<string, unknown>): Promise<string>;   // @zodern/ejs, filename = cesta šablony (kvůli include)
  function renderStartSh(c: NormalizedConfig, serverName: string): Promise<string>;
  function renderEnvList(c: NormalizedConfig, settings: unknown, serverName: string, o: { cwd: string; basePath: string }): Promise<string>;
  function renderMeteorStart(c: NormalizedConfig, o?: { removeImage?: boolean }): Promise<string>;
  function renderMeteorStop(c: NormalizedConfig): Promise<string>;
  function renderMeteorSetup(c: NormalizedConfig): Promise<string>;
  function renderMeteorDestroy(c: NormalizedConfig): Promise<string>;
  // oracle
  function mupEnvconfigFiles(configPath: string, settingsPath: string, serverName: string): Promise<{ startSh: string; envList: string }>;
  ```

- [ ] **Step 1: Zkopíruj šablony** a do `NOTICE` doplň seznam převzatých souborů.
- [ ] **Step 2: Write the failing tests.**
  - Pro fixtures `aaa-like`, `per-server-env` (per-server `env`, `bind`, `settings`), `mongo`, `proxy-le`, `proxy-lb`, `registry` (s `log`, `volumes`, `docker.args`, `docker.networks`) a pro každý jejich server platí: `renderStartSh` a `renderEnvList` jsou **byte-identické** s `mupEnvconfigFiles`.
  - Review Focus 1: settings `{"a":"x$HOME \"q\" ü","b":"<40 KB řetězec>"}`. `renderEnvList` obsahuje přesně řádek `  METEOR_SETTINGS=` + `JSON.stringify(settings)`. Žádné `$` se neexpanduje a `"` se neescapuje.
- [ ] **Step 3: Run test to verify it fails.** Run: `npx vitest run test/unit/remote/app-files.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implementuj orákulum `mupEnvconfigFiles`.**
  - Spusť MUP handler `meteor.envconfig` s podvrženými sessions.
  - Zachyť `copy` úlohy z nodemiral task listu: `src`, `vars` a `hostVars[host]`.
  - Vyrenderuj je MUP vlastním `@zodern/ejs`. Merge `hostVars` dělá nodemiral přes `lodash.merge` (ref. §3.1).
- [ ] **Step 5: Implementuj `app-files.ts`** portem výpočtu proměnných z `envconfig` v `mup/lib/plugins/meteor/command-handlers.js` (funkce `envconfig`, `createEnv` v `utils.js`). Platí:
  - `hostVars` per host se slučují `lodash.merge`,
  - `PORT` z `app.servers.<n>.env` jde do `start.sh`, ne do `env.list`,
  - per-server `settings` se resolvuje vůči cwd (`resolveUserPath` s base `cwd`).
- [ ] **Step 6: Run test to verify it passes.** Expected: PASS.
- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat: render MUP start.sh/env.list byte-identically"`

---

### Task 7: CLI framework, kontext, `validate` a `init`

**Files:**
- Create: `src/cli/registry.ts`, `src/core/context.ts`, `src/core/runner.ts`, `src/config/servers.ts`, `src/cli/commands/validate.ts`, `src/cli/commands/init.ts`
- Modify: `src/cli/main.ts`
- Test: `test/unit/cli/registry.test.ts`, `test/unit/config/servers.test.ts`, `test/unit/cli/validate.test.ts`, `test/unit/cli/init.test.ts`

**Interfaces:**
- Consumes: úkoly 2–6.
- Produces:
  ```ts
  interface GlobalArgs { config?: string; settings?: string; servers?: string; verbose?: boolean; 'show-hook-names'?: boolean }
  interface CommandModule { command: string; describe: string | false; group?: 'meteor' | 'docker' | 'mongo' | 'proxy'; builder?: (y: Argv) => Argv; strict?: boolean; needsConfig?: boolean; run(ctx: CommandContext, argv: Record<string, unknown>): Promise<void> }
  function registerCommands(y: Argv, modules: CommandModule[], makeCtx: (argv: GlobalArgs) => Promise<CommandContext>): Argv;
  interface CommandContext {
    cwd: string; basePath: string; configPath: string; raw: RawConfig; config: NormalizedConfig;
    issues: Issue[]; serverFilter: string[] | null; verbose: boolean; argv: Record<string, unknown>;
    reporter: Reporter; ssh: SshPool; runner: CommandRunner;
    getSettings(): unknown;                 // lazy, cachované, vrací stále stejný (mutovatelný) objekt
    appServers(): string[];                 // klíče app.servers ∩ serverFilter, v pořadí z konfigurace
  }
  function createContext(argv: GlobalArgs & Record<string, unknown>, deps?: { cwd?: string; reporter?: Reporter; sshPoolFactory?: (c: NormalizedConfig, cwd: string, basePath: string) => SshPool }): Promise<CommandContext>;
  class CommandRunner { run<T>(key: string, fn: () => Promise<T>): Promise<T>; history: string[] }   // key = MUP command key, např. 'meteor.push'; pre/post body pro fázi 2
  function parseServerFilter(v?: string): string[] | null;    // split /[\s,]+/, prázdné → null
  function selectServers(all: string[], filter: string[] | null): string[];   // neznámé jméno → CometError
  ```
  `SshPool` je z úkolu 8. V tomto úkolu použij jen typ a továrnu přes `deps`. Výchozí továrnu doplní úkol 8.

- [ ] **Step 1: Write the failing tests.**
  - `parseServerFilter('one,two three')` = `['one','two','three']`, `parseServerFilter('')` = `null`.
  - `selectServers(['one','two'], ['three'])` vyhodí `CometError` se zprávou obsahující `three`.
  - `CommandRunner.run('meteor.push', fn)` vrátí výsledek `fn` a do `history` přidá klíč.
  - `createContext` s fixture `aaa-like` naplní `config`. Fatální issue → `CometError` s výpisem chyb. Varování se vypíšou přes `reporter.warn` a pokračuje se.
  - `createContext` zaregistruje do reporteru `collectSecrets(config)`. `getSettings()` při prvním volání doplní i `collectSecrets(config, settings)`. Test: po `getSettings()` se hodnota ze settings v reporter výstupu maskuje.
  - `validate` na nevalidní fixture vypíše chyby a vrátí exit 1, `--show` vytiskne normalizovanou konfiguraci jako JSON, `--scrub` scrubnutou. `validate` nesmí vyhodit chybu na fatálních issues dřív, než je vypíše.
  - `init` v prázdném adresáři s Meteor aplikací (fixture s `.meteor/release`) vytvoří `.deploy/mup.js` (obsah ze šablony `mup.js.sample` s `<app path>` → `../`) a `.deploy/settings.json` (`{"public":{}}`). `init --json` vytvoří `mup.json` s ekvivalentním obsahem. Existující soubory nepřepíše a vypíše to. Pravidla umístění podle ref. §3.2 (`mup init`).
- [ ] **Step 2: Run tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implementuj.**
  - `registerCommands` vytvoří top-level příkazy a skupiny `meteor` a `docker` (`comet-deploy meteor deploy`). Příkazy se `strict: false` (logs) předávají neznámé volby dál v `argv`.
  - Globální volby: `--config`, `--settings`, `--servers`, `--verbose`, `--show-hook-names`.
  - `init` a `validate` nepotřebují SSH, takže `needsConfig` u `init` = `false`.
- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: CLI framework, context, validate and init commands"`

---

### Task 8: SSH vrstva

**Files:**
- Create: `src/ssh/options.ts`, `src/ssh/connection.ts`, `src/ssh/pool.ts`
- Modify: `src/core/context.ts` (výchozí `sshPoolFactory`)
- Test: `test/unit/ssh/options.test.ts`

**Interfaces:**
- Produces:
  ```ts
  function buildConnectOptions(server: ServerConfig, o: { cwd: string; basePath: string; env: NodeJS.ProcessEnv; readFile?: (p: string) => string }): import('ssh2').ConnectConfig;
  interface ExecResult { code: number; stdout: string; stderr: string }
  interface ExecOptions { onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void; stdin?: string | NodeJS.ReadableStream }
  class SshConnection {
    readonly name: string; readonly host: string;
    static connect(name: string, server: ServerConfig, o: { cwd: string; basePath: string }): Promise<SshConnection>;
    exec(command: string, o?: ExecOptions): Promise<ExecResult>;
    runScript(script: string, o?: ExecOptions): Promise<ExecResult>;        // `bash -s` se skriptem na stdin
    runScriptOrThrow(script: string, what: string, o?: ExecOptions): Promise<ExecResult>;   // nenulový kód → CometError s posledními 4200 znaky výstupu
    writeFile(remotePath: string, content: string, mode?: number): Promise<void>;  // SFTP
    putFile(localPath: string, remotePath: string, onProgress?: (sent: number, total: number) => void): Promise<void>;
    forwardIn(remotePort: number, onConnection: (stream: import('stream').Duplex) => void): Promise<{ port: number; close(): Promise<void> }>;  // bind 127.0.0.1
    close(): Promise<void>;
  }
  class SshPool { constructor(servers: Record<string, ServerConfig>, o: { cwd: string; basePath: string }); get(name: string): Promise<SshConnection>; closeAll(): Promise<void> }
  ```

- [ ] **Step 1: Write the failing tests** (Review Focus 5) pro `buildConnectOptions`:
  - `pem: '~/k.pem'` → `privateKey` = obsah `<home>/k.pem` (stub `readFile`) a nepoužije se `password`,
  - `pem` končící `.pub` → `CometError`,
  - jen `password: 'p@ss:w"rd'` → `password` beze změny,
  - bez pem a hesla s `env.SSH_AUTH_SOCK` → `agent` = ta hodnota,
  - bez všeho → `CometError` se jménem serveru,
  - `opts: { port: 2222, readyTimeout: 5000 }` → `port: 2222`, `readyTimeout: 5000`,
  - výchozí `keepaliveInterval: 28000`, `keepaliveCountMax: 12`, `readyTimeout: 60000`, `port: 22`,
  - `username` z konfigurace.
- [ ] **Step 2: Run test to verify it fails.** Run: `npx vitest run test/unit/ssh/options.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implementuj `options.ts`, `connection.ts`, `pool.ts`.**
  - `pem` se resolvuje vůči cwd s fallbackem (úkol 3).
  - `forwardIn` použije `client.forwardIn('127.0.0.1', port)` a událost `tcp connection`. Při `port = 0` vrátí přidělený port.
  - `SshPool.get` otevírá spojení líně, jedno na server. `closeAll` zavře všechna.
  - Chyba spojení → `CometError` s hostem a důvodem.
- [ ] **Step 4: Run test to verify it passes.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: ssh connection layer"`

---

### Task 9: Falešné servery pro integrační testy

**Files:**
- Create: `test/harness/fake-server/Dockerfile`, `test/harness/fake-server/entrypoint.sh`, `test/harness/fake-servers.ts`, `test/integration/harness.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface FakeServer { name: string; host: '127.0.0.1'; port: number; username: string; password: string; pemPath: string; containerId: string; exec(cmd: string): Promise<ExecResult>; stop(): Promise<void> }
  function startFakeServers(n: number, o?: { allowTcpForwarding?: boolean; user?: 'root' | 'deployer' }): Promise<FakeServer[]>;
  function fakeServersConfig(servers: FakeServer[], auth: 'password' | 'pem'): Record<string, ServerConfig>;
  ```

- [ ] **Step 1: Napiš image falešného serveru.**
  - Základ `docker:27-dind`, doplněné `openssh-server`, `bash`, `sudo`, `curl`, `shadow`.
  - Uživatelé: `root` s heslem a `deployer` se sudo NOPASSWD a členstvím ve skupině `docker`, oba s veřejným klíčem z vygenerovaného páru.
  - `AllowTcpForwarding` řízený env proměnnou.
  - Entrypoint spustí `dockerd` a `sshd`.
  - Image na Debianu (`apt-get`) je nutný kvůli `docker-setup.sh` (MUP předpokládá apt). Pro testy `setup` použij variantu `debian:bookworm` + Docker z get.docker.com, předpřipravenou při buildu image, aby test nestahoval Docker pokaždé.
- [ ] **Step 2: Implementuj `fake-servers.ts`.** Kontejnery jsou `--privileged`, sshd se publikuje na `127.0.0.1:<náhodný port>`, `stop()` kontejner odstraní. Čekání na připravenost: SSH `docker version` uspěje.
- [ ] **Step 3: Napiš integrační test** `harness.test.ts`: dva servery, `SshConnection` s heslem i pemem, `runScript('sudo docker version --format "{{.Server.Version}}"')` vrátí verzi. `forwardIn(0, …)` vrátí port > 0. (Spouští se až v úkolu 21.)
- [ ] **Step 4: Lint.** Run: `npx eslint test/harness test/integration`. Expected: bez chyb.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "test: fake ssh+docker servers harness"`

---

### Task 10: Vzdálené operace

**Files:**
- Create:
  - `templates/comet/{facts.sh,lock-acquire.sh,lock-release.sh,versions.sh,history-append.sh,history-read.sh,snapshot.sh,restore-snapshot.sh,retag.sh,destroy-extra.sh}`,
  - `src/remote/ops.ts`,
  - `src/build/version.ts` (jen `VERSION_RE` a `makeVersion`, `readGitInfo` doplní úkol 12).
- Test: `test/unit/remote/ops.test.ts`, `test/integration/remote-ops.test.ts`

**Interfaces:**
- Consumes: `SshConnection` (úkol 8), `renderTemplate` (úkol 6), naming (úkol 4).
- Produces:
  ```ts
  const VERSION_RE: RegExp;   // /^\d{8}-\d{6}(-[0-9a-f]{7})?(-dirty)?$/
  function makeVersion(d: Date, git?: { sha: string; dirty: boolean }): string;   // UTC, 'YYYYMMDD-HHMMSS[-sha7][-dirty]'
  interface ServerFacts { arch: string; dockerVersion: string | null; dockerRunning: boolean; dockerRootFreeBytes: number | null; hasBash: boolean }
  function parseFacts(stdout: string): ServerFacts;
  function serverFacts(conn: SshConnection): Promise<ServerFacts>;
  interface LockInfo { user: string; machine: string; pid: number; startedAt: string; command: string; tool: string }
  function acquireLock(conn: SshConnection, appName: string, info: LockInfo): Promise<{ ok: true } | { ok: false; holder: LockInfo | null }>;
  function readLock(conn: SshConnection, appName: string): Promise<LockInfo | null>;
  function releaseLock(conn: SshConnection, appName: string): Promise<void>;
  interface ImageVersions { latestId: string | null; previousId: string | null; versions: Array<{ tag: string; id: string }> }   // versions: seřazené od nejnovější
  function parseVersions(stdout: string): ImageVersions;
  function listVersions(conn: SshConnection, localRepo: string): Promise<ImageVersions>;
  function pruneVersions(conn: SshConnection, localRepo: string, keep: number): Promise<string[]>;   // nikdy nesmaže tag s id = latestId ani previousId
  function retagActivate(conn: SshConnection, localRepo: string, version: string): Promise<void>;   // latest→previous (pokud latest existuje), version→latest
  function retagRevert(conn: SshConnection, localRepo: string): Promise<boolean>;   // previous→latest; false, když previous není
  function retagTo(conn: SshConnection, localRepo: string, version: string): Promise<void>;   // pro rollback: latest→previous, version→latest
  function snapshotConfig(conn: SshConnection, appName: string): Promise<boolean>;   // false, když start.sh ještě neexistuje
  function restoreConfigSnapshot(conn: SshConnection, appName: string): Promise<boolean>;
  interface HistoryEntry { version: string | null; action: 'deploy' | 'reconfig' | 'restart' | 'rollback'; result: 'success' | 'failed' | 'reverted'; startedAt: string; durationMs: number; git?: { commit: string; branch: string; dirty: boolean }; user: string; machine: string; servers: string[]; tool: string }
  function appendHistory(conn: SshConnection, appName: string, e: HistoryEntry): Promise<void>;
  function readHistory(conn: SshConnection, appName: string, limit: number): Promise<HistoryEntry[]>;   // poškozené řádky přeskočí
  ```

- [ ] **Step 1: Write the failing unit tests.**
  - `makeVersion(new Date('2026-11-07T18:30:05Z'), { sha: 'abcdef1234', dirty: true })` = `20261107-183005-abcdef1-dirty`. Bez gitu = `20261107-183005`. Výsledek splňuje `VERSION_RE`.
  - `parseFacts` z výstupu `facts.sh` (definuj formát `key=value` po řádcích: `arch=x86_64`, `docker=27.3.1`, `docker_running=1`, `docker_free=123456`, `bash=1`) vrátí správné typy. `docker=` prázdné → `dockerVersion: null`.
  - `parseVersions` z výstupu `docker images --format '{{.Tag}} {{.ID}}' mup-app`: ignoruje tagy, které nesplňují `VERSION_RE` (kromě `latest`/`previous`), řadí verze sestupně a doplní `latestId`/`previousId`.
  - `readHistory` přeskočí nevalidní JSON řádek.
- [ ] **Step 2: Run test to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implementuj skripty a `ops.ts`.**
  - Všechny skripty dostávají hodnoty přes EJS `<%= %>`, ne přes interpolaci v shellu. `info.json` a historie se zapisují přes SFTP (`writeFile`) nebo stdin, nikdy přes `echo "$JSON"`.
  - `lock-acquire.sh` používá atomický `mkdir /opt/<name>/config/deploy.lock`.
  - `history-append.sh` přidává řádek přes `cat >> file` ze stdin.
  - Docker příkazy běží přes `sudo docker`.
- [ ] **Step 4: Run test to verify it passes.** Expected: PASS.
- [ ] **Step 5: Napiš integrační test** `remote-ops.test.ts` (spouští se v úkolu 21). Na falešném serveru:
  - lock: druhý acquire vrátí holdera, release, znovu acquire OK,
  - retag/prune s `busybox` image otagovaným jako verze,
  - snapshot/restore,
  - historie s hodnotou obsahující `'` a `$`.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: remote operations (facts, lock, versions, history, snapshot)"`

---

### Task 11: Preflight

**Files:**
- Create: `src/local/exec.ts`, `src/local/docker.ts`, `src/deploy/preflight.ts`
- Test: `test/unit/deploy/preflight.test.ts`, `test/unit/local/exec.test.ts`

**Interfaces:**
- Consumes: `serverFacts`, `readLock` (úkol 10), `SshPool` (úkol 8), `CommandContext` (úkol 7).
- Produces:
  ```ts
  function run(cmd: string, args: string[], o?: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean; input?: string; onLine?: (line: string, stream: 'stdout' | 'stderr') => void }): Promise<{ code: number; stdout: string; stderr: string }>;   // bez shellu
  function dockerAvailable(): Promise<{ ok: boolean; version?: string; error?: string }>;
  function buildxPlatforms(): Promise<string[]>;   // z `docker buildx inspect`
  type Platform = 'linux/amd64' | 'linux/arm64';
  function platformForArch(unameM: string): Platform;   // x86_64|amd64 → linux/amd64; aarch64|arm64 → linux/arm64; jinak CometError
  interface PreflightInput { local: { docker: { ok: boolean; version?: string; error?: string }; platforms: string[]; meteorOk: boolean }; servers: Record<string, { facts?: ServerFacts; error?: string; lock?: LockInfo | null }>; override: CometOptions['platform']; needsBuild: boolean; checkLocks: boolean }
  interface PreflightResult { errors: string[]; warnings: string[]; platformByServer: Record<string, Platform>; platforms: Platform[] }
  function evaluatePreflight(i: PreflightInput): PreflightResult;   // čistá funkce
  function runPreflight(ctx: CommandContext, servers: string[], o: { needsBuild: boolean; checkLocks: boolean }): Promise<PreflightResult>;   // paralelně; při errors vyhodí CometError se všemi chybami
  ```

- [ ] **Step 1: Write the failing tests** pro `platformForArch` a `evaluatePreflight`:
  - SSH chyba na jednom serveru → error se jménem serveru,
  - `dockerRunning: false` → error s nápovědou `comet-deploy setup`,
  - Docker `17.12.0` → error (minimum 18),
  - free < 5 GiB → warning,
  - zámek držený jiným uživatelem a `checkLocks` → error se jménem holdera a `comet-deploy unlock`,
  - lokální Docker chybí a `needsBuild` → error. `needsBuild: false` → bez chyby,
  - `platforms` neobsahuje `linux/amd64` a server je x86_64 → error s nápovědou zapnout emulaci v Docker Desktop,
  - `override: 'linux/arm64'` přebije `uname`,
  - `platforms` = unikátní seznam.

  `run('node', ['-e', 'console.log(1)'])` vrátí `code 0`, `stdout '1\n'`.
- [ ] **Step 2: Run tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implementuj.** `runPreflight` sbírá data paralelně (`Promise.allSettled`) a lokální `meteor --version` spouští, jen když `needsBuild`.
- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: preflight checks"`

---

### Task 12: Meteor build, verze Node, hash vstupů, cache

**Files:**
- Create: `src/build/meteor-build.ts`, `src/build/node-version.ts`, `src/build/input-hash.ts`, `src/build/cache.ts`
- Modify: `src/build/version.ts` (`readGitInfo`)
- Test: `test/unit/build/meteor-build.test.ts`, `test/unit/build/node-version.test.ts`, `test/unit/build/input-hash.test.ts`, `test/unit/build/cache.test.ts`, fixtures `test/fixtures/bundles/{star-json,node-version-txt}/bundle/…`

**Interfaces:**
- Produces:
  ```ts
  type MeteorArch = 'os.linux.x86_64' | 'os.linux.aarch64';
  function meteorArchFor(p: Platform): MeteorArch;
  function meteorBuildArgs(app: AppConfig, buildLocation: string, arch: MeteorArch, appPath: string): string[];
  function runMeteorBuild(app: AppConfig, o: { appPath: string; buildLocation: string; arch: MeteorArch; reporter: Reporter }): Promise<string>;   // vrací <buildLocation>/bundle
  function readNodeVersion(bundleDir: string): string;   // 'x.y.z'
  function computeInputHash(appPath: string, extra: Record<string, unknown>, o?: { exclude?: string[] }): Promise<string>;   // sha256 hex
  function readGitInfo(appPath: string): Promise<{ sha: string; branch: string; dirty: boolean } | null>;
  interface CacheEntry { inputHash: string; platform: Platform; version: string; localTag: string; imageId: string; bundleDir: string; nodeVersion: string; createdAt: string }
  class BuildCache { constructor(appPath: string, root?: string); lookup(inputHash: string, platform: Platform): CacheEntry | null; latest(platform: Platform): CacheEntry | null; save(e: CacheEntry): void }   // root default: $XDG_CACHE_HOME || ~/.cache, + '/comet-deploy/<sha256(appPath)[0..16]>/state.json'
  ```

- [ ] **Step 1: Write the failing tests.**
  - `meteorBuildArgs` vrací přesné pole podle ref. §4.1. Ověř:
    - `serverOnly`: `['build','--directory',L,'--architecture','os.linux.x86_64','--server-only']`,
    - `debug` + `mobileSettings {a:1}` + `server`: `[…,'--debug','--mobile-settings','{"a":1}','--server','https://x']`,
    - bez `serverOnly` i `mobileSettings`: `'--mobile-settings', join(appPath,'settings.json')`,
    - `allowIncompatibleUpdates: true` i `allowIncompatibleUpdate: true`: `'--allow-incompatible-update'`,
    - `arch` `os.linux.aarch64` se propíše.
  - `readNodeVersion`: z `star.json` `nodeVersion` (`24.22.1`). Bez `star.json` z `.node_version.txt` (`v14.21.4` → `14.21.4`).
  - `computeInputHash`:
    - změna obsahu `client/main.js` → jiný hash,
    - `touch` beze změny obsahu → stejný,
    - soubor v `.meteor/local/`, `node_modules/x/README` nebo `.git/` → stejný,
    - změna `version` v `node_modules/x/package.json` → jiný,
    - změna `extra` → jiný.
  - `BuildCache`: `save` + `lookup` v dočasném rootu. Jiná platforma → `null`.
- [ ] **Step 2: Run tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implementuj.**
  - `runMeteorBuild`:
    - když `cleanBuildLocation`, smaže `buildLocation` (`fs.rm` recursive, force),
    - spustí `<executable ?? 'meteor'>` s cwd = appPath a env `METEOR_HEADLESS=1`, výstup streamuje přes `reporter.verboseLine`,
    - chyba → `CometError` s posledními 50 řádky.
  - `computeInputHash` hashuje relativní cestu + obsah souborů. Z `node_modules` bere jen `name@version` z `node_modules/*/package.json` a `node_modules/@*/*/package.json`.
- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: meteor build, node version, input hash, build cache"`

---

### Task 13: Dockerfile s cachovanou vrstvou závislostí a stavba image

**Files:**
- Create: `src/build/dockerfile.ts`, `src/build/index.ts`
- Modify: `src/local/docker.ts` (`buildImage`, `pullImage`, `imageId`)
- Test: `test/unit/build/dockerfile.test.ts`, fixture `test/fixtures/bundles/meteor3/bundle/…` (struktura jako reálný Meteor 3.5.4 bundle: `main.js`, `star.json`, `README`, `server/`, `programs/web.browser/`, `programs/server/{package.json,npm-shrinkwrap.json,npm-rebuild.js,npm-rebuild-args.js,npm-rebuilds.json,boot.js,…,npm/node_modules/x/package.json}`; obsah souborů může být minimální, `npm-rebuild.js` musí obsahovat `require("./npm-rebuild-args.js")`)

**Interfaces:**
- Consumes: úkoly 4, 11, 12.
- Produces:
  ```ts
  function detectDepsFiles(serverDir: string): string[];   // relativní k programs/server, seřazené
  interface BuildContextPlan { depsCopy: string[]; appCopy: Array<{ from: string; to: string }> }   // cesty relativní ke kontextu (= buildLocation)
  function planBuildContext(bundleDir: string): BuildContextPlan;
  function renderDockerfile(o: { baseImage: string; buildInstructions: string[]; argKeys: string[]; plan: BuildContextPlan; chownApp: boolean }): string;
  function argKeysForInstructions(instructions: string[], envKeys: string[]): string[];
  function buildImage(o: { contextDir: string; dockerfile: string; platform: Platform; tag: string; buildArgs: Record<string, string>; onLine?: (l: string) => void }): Promise<{ imageId: string; log: string }>;   // docker buildx build --load -f - (stdin)
  function computeDepsHash(bundleDir: string, plan: BuildContextPlan): Promise<string>;   // sha256 obsahu depsCopy souborů (relativní cesta + obsah, bez mtime)
  interface BuiltImage { platform: Platform; version: string; localTag: string; imageId: string; nodeVersion: string; depsHash: string; fromCache: boolean }
  function buildApp(ctx: CommandContext, o: { platforms: Platform[]; version: string; cachedBuild: boolean; forceBuild: boolean }): Promise<BuiltImage[]>;
  ```

- [ ] **Step 1: Write the failing tests.**
  - `detectDepsFiles(<fixture>/programs/server)` = `['npm', 'npm-rebuild-args.js', 'npm-rebuild.js', 'npm-rebuilds.json', 'npm-shrinkwrap.json', 'package.json']`. Zahrnuje i soubory, které `npm-rebuild*.js` vyžaduje přes `require("./…")`, a jen ty, které existují.
  - `planBuildContext`: `depsCopy` = výše uvedené s prefixem `bundle/programs/server/`. `appCopy` pokrývá všechny ostatní položky `bundle/`, `bundle/programs/*` a `bundle/programs/server/*`, ale **neobsahuje** `bundle/programs/server/npm` ani deps soubory (assert: žádná položka `appCopy.from` nezačíná `bundle/programs/server/npm`).
  - `renderDockerfile` s `baseImage: 'zodern/meteor:latest'`, `chownApp: true`, `buildInstructions: ['RUN apt-get install -y x']`, `argKeys: ['FOO']`. Pořadí řádků je přesně:
    1. `FROM zodern/meteor:latest`,
    2. `RUN mkdir /built_app || true`,
    3. `ARG FOO`,
    4. `RUN apt-get install -y x`,
    5. `COPY --chown=app:app <deps…> /built_app/programs/server/`, kde adresář `npm` má vlastní `COPY … /built_app/programs/server/npm`,
    6. `RUN cd /built_app/programs/server && npm install --unsafe-perm`,
    7. `COPY --chown=app:app` pro každou položku `appCopy`.

    Neobsahuje žádné hodnoty z env. `chownApp: false` → bez `--chown`.
  - `argKeysForInstructions(['RUN echo $FOO ${BAR}'], ['FOO','BAR','BAZ'])` = `['BAR','FOO']`.
  - `computeDepsHash` pro dvě kopie fixture s různými mtime vrátí stejný hash. Změna `npm/node_modules/x/package.json` vrátí jiný. Hash se uloží do `CacheEntry` (přidej pole `depsHash`) a do image jako `LABEL comet-deploy.deps-hash=<hash>`, aby šlo ve fázi CI sdílet deps image podle hashe (spec §8 bod 4).
- [ ] **Step 2: Run tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implementuj.**
  - `chownApp` = `docker.image` začíná `zodern/meteor`.
  - `buildApp`:
    1. pro každou platformu `computeInputHash` (extra: `buildOptions`, platforma, verze nástroje, `docker.image`, `buildInstructions`),
    2. při cache hitu a existujícím `imageId` (`docker image inspect`) vrátí `fromCache: true`, bez `--force-build`,
    3. jinak `docker pull --platform <p> <docker.image>` (chyba se ignoruje),
    4. `runMeteorBuild`,
    5. `readNodeVersion`,
    6. `buildImage` s build argy `NODE_VERSION` a hodnotami `argKeys` z `app.env` (při neprázdných `argKeys` reporter vypíše varování: `build args are visible in image history`),
    7. tag `<localImageRepo>:<version>` (s více platformami `<version>-<arch>`, kde `arch` = `amd64`/`arm64`),
    8. `BuildCache.save`.
  - `--cached-build` použije `BuildCache.latest(platform)` bez ohledu na hash a hlášku `Unable to use previous build`, když není.
  - `docker.image` = `kadirahq/meteord` nebo jiný image bez podpory prepare (ref. §2.3 `docker.prepareBundle`) → `CometError` „bundle mode is planned for phase 2“.
- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: layered Dockerfile and local image build"`

---

### Task 14: Lokální registry, reverse tunel a distribuce

**Files:**
- Create: `src/transfer/local-registry.ts`, `src/transfer/tunnel.ts`, `src/transfer/distribute.ts`, `templates/comet/pull-via-tunnel.sh`
- Test: `test/unit/transfer/distribute.test.ts`, `test/integration/transfer.test.ts`

**Interfaces:**
- Consumes: `SshConnection.forwardIn` (úkol 8), `run` (úkol 11), naming (úkol 4).
- Produces:
  ```ts
  function ensureLocalRegistry(): Promise<{ port: number }>;   // registry:2.8.3, kontejner comet-deploy-registry, -p 127.0.0.1::5000, volume comet-deploy-registry-data
  function pushToLocalRegistry(localTag: string, port: number): Promise<string>;   // vrací repo:tag v registry, např. 'mup-app:20261107-183005' (bez hostu)
  function stopLocalRegistry(): Promise<void>;
  function openReverseTunnel(conn: SshConnection, localPort: number): Promise<{ remotePort: number; close(): Promise<void> }>;
  class TunnelUnavailableError extends CometError {}
  function pullScriptVars(o: { remotePort: number; registryRef: string; targetTag: string; baseImage: string }): Record<string, string>;
  function distributeToServer(conn: SshConnection, o: { registryPort: number; registryRef: string; targetTag: string; baseImage: string; onStatus?: (s: string) => void }): Promise<{ durationMs: number }>;
  ```

- [ ] **Step 1: Write the failing unit test** pro `pullScriptVars` + vyrenderovaný `pull-via-tunnel.sh` (`remotePort 40123`, `registryRef 'mup-app:v1'`, `targetTag 'mup-app:v1'`, `baseImage 'zodern/meteor:latest'`). Skript:
  - obsahuje v tomto pořadí `sudo docker pull zodern/meteor:latest || true`, `sudo docker pull 127.0.0.1:40123/mup-app:v1`, `sudo docker tag 127.0.0.1:40123/mup-app:v1 mup-app:v1` a `sudo docker rmi 127.0.0.1:40123/mup-app:v1`,
  - začíná `set -e` (mimo řádek s `|| true`).
- [ ] **Step 2: Run test to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implementuj.**
  - `ensureLocalRegistry` spustí existující zastavený kontejner (`docker start`), jinak `docker run -d`. Port čte přes `docker port comet-deploy-registry 5000/tcp`. Čeká, až `GET http://127.0.0.1:<port>/v2/` vrátí 200.
  - `openReverseTunnel`:
    - `forwardIn(0, stream => pipe na net.connect(localPort, '127.0.0.1'))`, obousměrně, s ošetřením chyb a zavřením,
    - chyba typu „administratively prohibited“ nebo „Unable to bind“ → `TunnelUnavailableError` s nápovědou `AllowTcpForwarding yes` (stream fallback je ve fázi 2).
  - `distributeToServer`: tunel → skript → vždy `close()` (finally).
- [ ] **Step 4: Run test to verify it passes.** Expected: PASS.
- [ ] **Step 5: Napiš integrační test** `transfer.test.ts` (spouští se v úkolu 21):
  - lokální `busybox` otagovaný jako `mup-app:v1`, push, distribuce na 2 falešné servery paralelně, na obou existuje `mup-app:v1` a neexistuje tag `127.0.0.1:*`,
  - druhá distribuce image, který se liší jen malou vrstvou, přenese jen ji. Ověř z výstupu `docker pull`: řádky `Already exists` pro sdílené vrstvy,
  - falešný server s `allowTcpForwarding: false` → `TunnelUnavailableError`.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: local registry + reverse ssh tunnel image distribution"`

---

### Task 15: Health check, aktivace, návrat a strategie

**Files:**
- Create: `templates/comet/health-check.sh`, `src/deploy/health-check.ts`, `src/deploy/activate.ts`, `src/deploy/strategy.ts`
- Test: `test/unit/deploy/health-check.test.ts`, `test/unit/deploy/strategy.test.ts`, `test/unit/deploy/activate.test.ts`

**Interfaces:**
- Consumes: úkoly 6, 8, 10.
- Produces:
  ```ts
  type HealthResult = { ok: true; status: number; seconds: number } | { ok: false; reason: 'timeout' | 'crashed' | 'no-ip'; lastStatus?: number; seconds: number };
  function parseHealthResult(stdout: string): HealthResult;   // poslední řádek 'COMET_HEALTH ok <status> <s>' | 'COMET_HEALTH fail <reason> <lastStatus|-> <s>'
  function healthCheck(conn: SshConnection, o: { container: string; port: number; path: string; maxStatus: number; timeoutSec: number }): Promise<HealthResult>;
  interface ActivationResult { server: string; status: 'healthy' | 'reverted' | 'revert-failed' | 'failed'; durationMs: number; error?: string; logsTail?: string; health?: HealthResult }
  interface ActivateDeps { conn: SshConnection; config: NormalizedConfig; settings: unknown; serverName: string; cwd: string; basePath: string; reporter: Reporter }
  function activateServer(d: ActivateDeps, o: { version: string | null; mode: 'deploy' | 'reconfig' | 'rollback' }): Promise<ActivationResult>;
  function revertServer(d: ActivateDeps, o: { revertImage: boolean }): Promise<boolean>;
  function runStrategy(servers: string[], strategy: CometOptions['strategy'], fn: (s: string) => Promise<ActivationResult>): Promise<{ results: ActivationResult[]; skipped: string[] }>;
  ```

- [ ] **Step 1: Write the failing tests.**
  - `parseHealthResult('…\nCOMET_HEALTH ok 200 7')` → `{ ok: true, status: 200, seconds: 7 }`. Pro `'COMET_HEALTH fail crashed - 3'` → `{ ok: false, reason: 'crashed', seconds: 3 }`.
  - Vyrenderovaný `health-check.sh` (port 3000, path `/healthz`, maxStatus 499, timeout 60):
    - obsahuje `curl` s `-o /dev/null -w '%{http_code}'` a `--max-time`,
    - kontroluje `.State.Status` přes `docker inspect`,
    - pro síť `host` používá `localhost` (stejná detekce jako ref. §4.9).
  - `runStrategy`, s falešnou `fn`, která zaznamenává časy startu a konce:
    - `canary` volá první server samotný, pak ostatní současně (každý další start < konec ostatních),
    - když canary vrátí `reverted`, ostatní jsou ve `skipped`,
    - `rolling` jde jeden po druhém a zastaví se na prvním neúspěchu,
    - `parallel` spustí všechny najednou,
    - pole `results` je v pořadí serverů.
  - `activateServer` s mock `SshConnection` (zaznamenává volané skripty):
    - mód `deploy`, health OK: pořadí snapshot → `retagActivate(version)` → zápis `start.sh` a `env.list` (obsah z úkolu 6) → `meteor-start.sh` → health → `healthy`,
    - health fail: navíc `docker logs --tail 100`, `restoreConfigSnapshot`, `retagRevert`, `sudo bash /opt/<name>/config/start.sh` → `reverted` s `logsTail`,
    - mód `reconfig`: bez retagu a při selhání `revertServer({ revertImage: false })`.
- [ ] **Step 2: Run tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implementuj.** Kroky aktivace podle spec §10.2 (bez nulového výpadku, ten je ve fázi 2). Port a timeout health checku podle Global Constraints.
- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: health check, activation with revert, rollout strategies"`

---

### Task 16: Pipeline deploye a příkaz `deploy`

**Files:**
- Create: `src/deploy/history.ts`, `src/deploy/pipeline.ts` (`deployPipeline`), `src/cli/commands/deploy.ts` (top-level `deploy` + skryté `meteor deploy|push|build`)
- Test: `test/unit/deploy/pipeline.test.ts`, `test/unit/deploy/history.test.ts`

**Interfaces:**
- Consumes: úkoly 7–15.
- Produces:
  ```ts
  function makeHistoryEntry(o: { action: HistoryEntry['action']; version: string | null; result: HistoryEntry['result']; startedAt: Date; durationMs: number; git: Awaited<ReturnType<typeof readGitInfo>>; servers: string[] }): HistoryEntry;   // user = git user.name || os.userInfo().username, machine = os.hostname(), tool = 'comet-deploy@<ver>'
  function mergeHistory(perServer: Record<string, HistoryEntry[]>, limit: number): Array<HistoryEntry & { reportedBy: string[] }>;
  interface PipelineDeps { preflight: typeof runPreflight; buildApp: typeof buildApp; ensureLocalRegistry: typeof ensureLocalRegistry; pushToLocalRegistry: typeof pushToLocalRegistry; stopLocalRegistry: typeof stopLocalRegistry; distributeToServer: typeof distributeToServer; activateServer: typeof activateServer; acquireLock: typeof acquireLock; releaseLock: typeof releaseLock; appendHistory: typeof appendHistory; pruneVersions: typeof pruneVersions; signal?: AbortSignal }
  interface DeployOutcome { version: string; results: ActivationResult[]; skipped: string[]; ok: boolean }
  function deployPipeline(ctx: CommandContext, o: { cachedBuild: boolean; forceBuild: boolean; strategy?: CometOptions['strategy'] }, deps?: Partial<PipelineDeps>): Promise<DeployOutcome>;
  ```

- [ ] **Step 1: Write the failing tests** (všechny závislosti jsou fakes přes `deps`):
  - Úspěšný běh volá v pořadí (každá fáze přes `ctx.runner.run` s klíči `meteor.deploy`, `meteor.push`, `meteor.build`, `meteor.prepareBundle`, `default.reconfig`, `meteor.envconfig`, `meteor.start`): preflight → `ctx.getSettings()` → build → lock na všech serverech → registry + push → distribuce na všech serverech (paralelně) → `runStrategy`/aktivace → `appendHistory` na každém serveru → prune (`keepVersions`) → release locků → `stopLocalRegistry`. Konfigurace s `proxy` nebo `mongo` skončí `CometError` (phase 2).
  - **Review Focus 2:** `AbortSignal` aborted po distribuci → `activateServer` se nevolá, `releaseLock` se volá na všech serverech, `stopLocalRegistry` se volá a výsledek je `CometError('Deploy aborted')`. Stejně tak výjimka z `distributeToServer` na jednom serveru: aktivace se nespustí a locky se uvolní.
  - `acquireLock` vrátí holdera na jednom serveru: locky už získané na ostatních se uvolní a chyba obsahuje jméno holdera.
  - Výsledek: canary `reverted` → `ok: false`, ostatní `skipped` a `history.result` = `reverted` na canary. Parallel s jedním `reverted` a jedním `healthy` → `ok: false` a souhrn (reporter) obsahuje text `MIXED VERSIONS` a `comet-deploy rollback`.
  - `mergeHistory` sloučí stejné záznamy (`startedAt` + `version` + `action`) ze dvou serverů do jednoho s `reportedBy: ['one','two']` a seřadí sestupně.
- [ ] **Step 2: Run tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implementuj** `history.ts`, `deployPipeline` a příkaz `deploy`:
  - každý server dostane `BuiltImage` své platformy (`platformByServer` z preflightu), `registryRef` = výsledek `pushToLocalRegistry` pro tu platformu a `targetTag` = `<localImageRepo>:<version>`, bez suffixu architektury,
  - volby `--cached-build`, `--force-build`, `--strategy`,
  - SIGINT → `AbortController.abort()`, druhý SIGINT ukončí proces,
  - exit code 1 při `ok: false`.
  - `meteor build` (skrytý) jen postaví image. `meteor push` postaví a rozešle bez aktivace.
- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: deploy pipeline and deploy command"`

---

### Task 17: `reconfig`, `restart`, `start`, `stop`, `logs`

**Files:**
- Create: `src/cli/commands/lifecycle.ts` (top-level + `meteor` varianty a skrytý `meteor envconfig`)
- Modify: `src/deploy/pipeline.ts` (`reconfigPipeline`, `restartPipeline`)
- Test: `test/unit/deploy/lifecycle.test.ts`, `test/unit/cli/logs.test.ts`

**Interfaces:**
- Consumes: úkoly 10, 15, 16.
- Produces:
  ```ts
  function reconfigPipeline(ctx: CommandContext, o: { strategy?: CometOptions['strategy'] }, deps?: Partial<PipelineDeps>): Promise<DeployOutcome>;   // lock → activateServer(mode 'reconfig') přes runStrategy → history 'reconfig' → unlock
  function restartPipeline(ctx: CommandContext, o: { strategy?: CometOptions['strategy'] }, deps?: Partial<PipelineDeps>): Promise<DeployOutcome>;   // lock → stop+start+health per server → history 'restart' → unlock; bez revertu
  function buildLogsCommand(appName: string, passthrough: Array<string | number>): string;   // 'sudo docker logs <args> <name> 2>&1', argumenty shell-escapované
  ```

- [ ] **Step 1: Write the failing tests.**
  - `reconfigPipeline` volá `activateServer` s `mode: 'reconfig'` a `version: null`, s klíči runneru `default.reconfig` → `meteor.envconfig` → `meteor.start`, a uvolní locky i při výjimce.
  - `restartPipeline` při neúspěšném health checku vrátí `ok: false` bez retagu.
  - `buildLogsCommand('app', ['-f','--tail', 50])` = `sudo docker logs -f --tail 50 app 2>&1`.
  - `logs` příkaz prefixuje každý řádek `[<host>]` (ref. §3.3).
  - `stop` a `start` běží paralelně. `start` po startu dělá health check a vypíše výsledek.
- [ ] **Step 2: Run tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implementuj.** `start` = `meteor-start.sh` + health. `stop` = `meteor-stop.sh`. `restart` = stop + start + health podle strategie. `logs` streamuje výstup ze všech serverů souběžně.
- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: reconfig, restart, start, stop, logs commands"`

---

### Task 18: `rollback`, `history`, `unlock`

**Files:**
- Create: `src/deploy/rollback.ts`, `src/cli/commands/rollback.ts`, `src/cli/commands/history.ts`, `src/cli/commands/unlock.ts`
- Modify: `src/deploy/pipeline.ts` (`rollbackPipeline`)
- Test: `test/unit/deploy/rollback.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type RollbackTarget = { kind: 'version'; tag: string } | { kind: 'previous' } | { kind: 'none'; reason: string };
  function chooseRollbackTarget(v: ImageVersions, to?: string): RollbackTarget;
  function rollbackPipeline(ctx: CommandContext, o: { to?: string; strategy?: CometOptions['strategy'] }, deps?: Partial<PipelineDeps>): Promise<DeployOutcome>;
  ```

- [ ] **Step 1: Write the failing tests** (Review Focus 4) pro `chooseRollbackTarget`:
  - `versions` `[v3(id=c), v2(id=b), v1(id=a)]`, `latestId: c` → `{ kind:'version', tag: v2 }`,
  - `to: v1` → `v1`,
  - `to: 'nope'` → `none` se seznamem dostupných verzí v `reason`,
  - server jen od MUP (`versions: []`, `previousId: 'p'`) → `{ kind: 'previous' }`,
  - `versions: []`, `previousId: null` → `none`,
  - `latestId` neodpovídá žádné verzi (MUP mezitím nasadil) → první verze (nejnovější) s id ≠ latestId.
- [ ] **Step 2: Run test to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implementuj.**
  - **`rollbackPipeline`:**
    - lock → `listVersions` na každém serveru → cíl → `retagTo` (u `previous`: `retagRevert`) → `sudo bash start.sh` → health → history `rollback` → unlock,
    - konfigurace se nemění (spec §11),
    - server s `none` → `failed` s důvodem a ostatní pokračují podle strategie.
  - **`history`:** `--limit` (výchozí 20), tabulka `TIME  ACTION  VERSION  RESULT  BY  COMMIT  SERVERS`.
  - **`unlock`:** vypíše holdera na každém serveru a zámek uvolní. `--force-unlock` u `deploy`/`reconfig`/`restart`/`rollback` uvolní zámek před acquire. Přidej `forceUnlock?: boolean` do parametru `o` u `deployPipeline`, `reconfigPipeline`, `restartPipeline` a `rollbackPipeline` a doplň test: s `forceUnlock` se volá `releaseLock` před `acquireLock`.
- [ ] **Step 4: Run test to verify it passes.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: rollback, history and unlock commands"`

---

### Task 19: `setup`, `docker *`, `meteor setup|destroy`, `status`

**Files:**
- Create: `src/cli/commands/setup.ts`, `src/cli/commands/docker.ts`, `src/cli/commands/status.ts`, `src/cli/commands/destroy.ts`
- Test: `test/unit/cli/setup.test.ts`, `test/unit/cli/status.test.ts`

**Interfaces:**
- Produces:
  ```ts
  function uniqueHosts(c: NormalizedConfig, servers: string[]): string[];   // servery s unikátním host (app + mongo + proxy serverů, ref. §3.4)
  interface StatusRow { server: string; docker: string; container: 'running' | 'stopped' | 'missing' | 'restarting'; version: string | null; lock: string | null; http: number | null }
  function parseStatus(stdout: string): Omit<StatusRow, 'server'>;
  ```

- [ ] **Step 1: Write the failing tests.**
  - `uniqueHosts` vyřadí druhý server se stejným `host`.
  - `setup` volá `docker-setup.sh` (MUP šablona) paralelně na unikátních hostech, pak `meteor-setup.sh` paralelně na app serverech, s klíči runneru `default.setup` → `docker.setup` → `meteor.setup`. S `proxy`/`mongo` vypíše varování, že tyto části přijdou ve fázi 2.
  - `meteor destroy` bez `--force` skončí chybou. S `--force` spustí `meteor-stop.sh`, `meteor-destroy.sh` a `destroy-extra.sh`, který smaže version tagy, `deploy-history.jsonl`, `deploy.lock` a `.prev`.
  - `parseStatus` z výstupu `status.sh` (formát `key=value`, definuj sám) vrátí `StatusRow`.
- [ ] **Step 2: Run tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implementuj.**
  - `docker setup|update|restart|ps|status` podle ref. §3.4 (`destroy-cluster` vypíše, že swarm není podporovaný).
  - `status` vypíše tabulku ze `StatusRow`. Verzi určí podle `latestId` ve `listVersions`.
  - `docker ps` předává volby dál (`strict: false`).
- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: setup, docker, destroy and status commands"`

---

### Task 20: Ukázková aplikace, integrační a e2e scénáře

**Files:**
- Create:
  - `test/fixtures/sample-app/` (Meteor 3.5.4, vytvořeno `meteor create --release 3.5.4 --minimal sample-app`, + `meteor npm install bcrypt`; commitují se jen zdrojáky a lockfile, bez `node_modules` a `.meteor/local`),
  - `test/e2e/deploy.test.ts`, `test/integration/interop.test.ts`, `test/integration/helpers.ts`.

**Interfaces:**
- Consumes: `startFakeServers` (úkol 9), `main` (úkol 1).
- Produces:
  ```ts
  function writeTestConfig(dir: string, servers: FakeServer[], o?: { env?: Record<string, string>; strategy?: string; auth?: 'password' | 'pem' }): string;   // mup.js + settings.json do dir, vrací cestu
  function cli(args: string[], cwd: string): Promise<{ code: number; output: string }>;
  ```

- [ ] **Step 1: Ukázková aplikace.**
  - `server/main.js`:
    - `if (process.env.CRASH_ON_START === '1') process.exit(1)`,
    - `WebApp.handlers.get('/native', (req, res) => res.end(String(require('bcrypt').hashSync('x', 4).length)))`,
    - `WebApp.handlers.get('/env', …)` vrátí `JSON.stringify({ s: Meteor.settings.public.s, e: process.env.SPECIAL })`.
  - `.gitignore` aplikace ignoruje `node_modules` a `.meteor/local`.
- [ ] **Step 2: Napiš e2e scénář** `test/e2e/deploy.test.ts`. Dva falešné servery, `docker.image: 'zodern/meteor:latest'`:
  1. `setup` → exit 0.
  2. `deploy` → exit 0. `curl` na obou serverech: `/native` = `60` a `/env` vrací přesné hodnoty se speciálními znaky (Review Focus 1: settings `{"public":{"s":"x$HOME \"q\" ü"}}`, env `SPECIAL: 'a b$c"d'`).
  3. Změna jen `server/main.js` → `deploy`. Výstup buildu obsahuje `CACHED` u kroku `npm install` (povinné ověření ze spec §8) a výstup distribuce obsahuje `Already exists`.
  4. `reconfig` s `env.CRASH_ON_START = '1'` → exit 1, canary `reverted`, druhý server `skipped`. Aplikace na obou dál odpovídá a env.list na canary je obnovený.
  5. `rollback` → exit 0, `history` obsahuje `deploy`, `reconfig` (reverted) a `rollback`.
  6. Souběžný druhý `deploy` během prvního → druhý skončí chybou zámku.
  7. `stop` → kontejner neběží. `start` → běží.
- [ ] **Step 3: Napiš interop scénář** `test/integration/interop.test.ts` (Review Focus 4):
  1. `mup setup` + `mup deploy` (MUP z devDependency, stejná konfigurace) → náš `deploy` → `mup restart`, `mup logs --tail 5` a `mup deploy` uspějí,
  2. potom náš `rollback` vrátí verzi nasazenou MUPem (`kind: 'previous'`),
  3. `history` na serveru bez historie vypíše prázdný seznam bez chyby.
- [ ] **Step 4: Lint.** Run: `npx eslint test`. Expected: bez chyb.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "test: sample app, e2e and MUP interop scenarios"`

---

### Task 21: Finální ověření, review a akceptace

**Files:**
- Modify: cokoliv, co vyleze z kontrol

- [ ] **Step 1: Statické kontroly.** Run: `npm run lint && npm run typecheck && npm run build`. Expected: bez chyb. `dist/cli/main.js` existuje a `node dist/cli/main.js --version` vypíše `0.1.0`.
- [ ] **Step 2: Unit testy.** Run: `npm test`. Expected: všechny PASS.
- [ ] **Step 3: Integrační a e2e testy.** Run: `npm run test:integration`. Expected: všechny PASS. Zvlášť zkontroluj:
  - cache hit u `npm install` (úkol 20, krok 3),
  - fungování registry přes `127.0.0.1` na Docker Desktop (úkol 14).

  Pokud cache nefunguje, zaveď vlastní deps image podle hashu obsahu (spec §8 bod 3) a doplň test.
- [ ] **Step 4: Oprav všechny nalezené chyby.** Opakuj kroky 1–3 do zelena. Commit oprav: `fix: …`.
- [ ] **Step 5: Code review celé větve** (superpowers:requesting-code-review). Zapracuj nálezy a commitni.
- [ ] **Step 6: Akceptace na testovacím serveru uživatele.**
  - Požádej uživatele o přístup (host, uživatel, auth).
  - S kopií konfigurace ve tvaru aaa-brain (jiný `name`, ROOT_URL a port, žádný produkční MONGO_URL bez svolení) proveď: `setup` → `deploy` → změna jen kódu → `deploy`.
  - Zaznamenej časy fází z reportu a stejný scénář změř s `mup deploy`.

  Kritérium (spec §16): po změně kódu je čas od konce `meteor build` do „healthy“ ≤ 60 s + 2× start aplikace při `canary`. Výsledky předlož uživateli.
- [ ] **Step 7: Předání.** Shrň uživateli, co je hotové, výsledky měření a známé limity. Merge do `main` a push jen na jeho pokyn.
