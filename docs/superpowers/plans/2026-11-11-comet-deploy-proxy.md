# comet-deploy, fáze 2, projekt 1: reverzní proxy (plán implementace)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Config se sekcí `proxy` funguje v comet-deploy beze změny. Všechny příkazy `proxy *` a proxy část `setup`/`status` dávají na serveru stejný stav jako MUP 1.5.11. Navíc umí:
- promítnout soubory proxy při `deploy`/`reconfig`,
- přepnout aplikaci za proxy bez výpadku,
- vyřadit server z upstreamu při load balancingu,
- restartovat proxy jen při změně.

**Architecture:**
- **MUP skripty a šablony** proxy se převezmou byte po bytu do `templates/mup/proxy/` a renderují se jako ve fázi 1.
- **Nový modul `src/proxy/`:**
  - renderery,
  - model souboru `upstream/<app>` se značkami `down` a řadič vyřazování,
  - synchronizace souborů proxy pro aplikaci a spouštěč nového vygenerování nginx konfigurace,
  - `ProxyRollout`, který pipelines obalí kolem aktivace.
- **Přepnutí bez výpadku** je nová cesta v `src/deploy/activate.ts`, odvozená z `config/start.sh` na serveru.
- **Příkazy** jsou ve skupině `proxy` v `src/cli/commands/proxy.ts`.

**Tech Stack:** jako fáze 1: TypeScript strict ESM, `ssh2`, `@zodern/ejs@2.7.5`, `vitest@2`, orákulum `mup@1.5.11` (devDependency). Testovací ACME server: Pebble (`ghcr.io/letsencrypt/pebble`).

**Spec:** `docs/superpowers/specs/2026-11-11-comet-deploy-proxy-design.md` (dál „spec“). Navazuje na `docs/superpowers/specs/2026-11-07-comet-deploy-design.md` (dál „hlavní spec“). Chování MUP popisuje `docs/reference/mup-1.5.11.md` (dál „ref.“) a kód `node_modules/mup/lib/plugins/proxy/` (`command-handlers.js`, `utils.js`, `assets/`).

## Global Constraints

- **Git:**
  - Pracuje se na větvi `feat/proxy`, nikdy na `main`. Merge a push jen na výslovný pokyn uživatele.
  - Kód, komentáře, testy, commity a CLI výstupy jsou anglicky.
  - Commity nesmí obsahovat `Co-Authored-By` ani jinou AI atribuci.
- **Testy (pokyn uživatele):**
  - V každém úkolu se spouští jen jeho vlastní unit test soubory (`npx vitest run <soubory>`) a `npx eslint <dotčené soubory>`.
  - Celá unit sada, `npm run typecheck`, `npm run build`, integrační testy (Docker) a code review běží **jen v úkolu 10**.
  - **Jediná výjimka je úkol 1:** spouští svůj jeden integrační soubor, protože spec §6 a hlavní spec §10.2 chtějí ověření Dockeru 29 a prototyp nulového výpadku hned na začátku.
- **Stav na serveru je identický s MUP 1.5.11 (ref. §6):**
  - kontejnery `mup-nginx-proxy`, `mup-nginx-proxy-letsencrypt`, `mup-proxy-configure-<app>`,
  - adresář `/opt/mup-nginx-proxy`,
  - image `zodern/nginx-proxy:v1.1.0` a `jrcs/letsencrypt-nginx-proxy-companion:v1.13.1`,
  - konfigurační kontejner `busybox:1.28.4`.
- **Šablony z MUP:**
  - Šablony a skripty proxy z MUP leží v `templates/mup/proxy/` jako **byte-identické kopie** `node_modules/mup/lib/plugins/proxy/assets/**`, ve stejném rozložení (kvůli `<% include ../proxy-stop.sh %>`).
  - Proměnné šablon jsou přesně takové, jaké předává `command-handlers.js`.
- **Nové artefakty na serveru (navíc k fázi 1) jsou jen tyto:**
  - značka ` down` v řádku `server <host>:<port> down;` souboru `/opt/mup-nginx-proxy/upstream/<app>`,
  - přechodný kontejner `<app.name>-next`.

  Nic jiného pod `/opt/mup-nginx-proxy` nevzniká.
- **Konstanty:**
  - čekání po vyřazení `DRAIN_WAIT_MS = 5000`,
  - zastavení starého kontejneru `docker stop -t 10`,
  - čekání, než se nový kontejner objeví ve vygenerované nginx konfiguraci: `NGINX_PICKUP_TIMEOUT_MS = 15000` [ruling autora plánu].
- `cometDeploy.zeroDowntime: false` vypne nulový výpadek (spec §4.3) i vyřazování (spec §4.4). Nová volba se nezavádí.
- **Tajné hodnoty:** hodnoty `proxy.shared.env` a `proxy.shared.envLetsEncrypt` reporter maskuje (stejné pravidlo jako u `app.env`). Obsah privátního klíče se nikdy nevypisuje ani neposílá přes příkazovou řádku, jen přes SFTP.
- **Veřejná dokumentace a commity** nezmiňují konkrétní aplikace, servery ani IP adresy uživatele.
- **Fake servery** mají Docker 27.5 (výchozí) a variantu s Dockerem 29.x (úkol 1).

## Review Focus

1. **Dvě aplikace na jedné proxy:** deploy nebo `proxy setup` aplikace B nesmí změnit soubory proxy aplikace A (vhost.d, certifikáty, upstream), ani ji odstavit. Test: úkol 8, scénář „two apps“.
2. **Ne-root uživatel se sudo (`deployer`):** MUP proxy skripty volají `docker` místy bez `sudo`. Naše vlastní skripty používají `sudo` všude a celý scénář musí projít i jako `deployer`. Test: úkol 8, LE scénář s `user: 'deployer'`.
3. **Ctrl+C během vyřazení:** server, který prošel health checkem, se vrátí do upstreamu. Server, který ještě neběží, zůstane `down` a souhrn to řekne. Test: úkol 7, `ProxyRollout` s injektovaným abortem.
4. **Nedostupný proxy server při vyřazení nebo návratu:**
   - Vyřazení se na něm vynechá s varováním a deploy pokračuje.
   - Neúspěšný návrat se objeví v souhrnu i s příkazem, který server vrátí.

   Test: úkol 3 (řadič s `apply`, které vyhodí) a úkol 7.
5. **Chybějící soubor `ssl.crt`/`ssl.key`, `nginxServerConfig`, `nginxLocationConfig` nebo `shared.nginxConfig`:** deploy i `proxy setup` skončí `CometError` se jménem souboru ještě před buildem nebo před prvním zápisem na server. Test: úkol 4 (`desiredProxyFiles`) a úkol 7 (pořadí v pipeline).

---

### Task 1: Brána: Docker 29, prototyp nulového výpadku, spouštěč regenerace

**Files:**
- Modify: `test/harness/fake-server/Dockerfile` (ARG `DOCKER_VERSION`, výchozí `27.5`), `test/harness/fake-servers.ts` (volba `docker?: '27.5' | '29'`, image tag `comet-fake-server:2-docker<ver>`)
- Modify: `test/integration/helpers.ts` (`writeTestConfig` dostane `proxy?: Record<string, unknown>` a `cometDeploy?: Record<string, unknown>`)
- Create: `test/integration/proxy-gate.test.ts`

**Interfaces:**
- Produces: `startFakeServers(n, { docker?: '27.5' | '29', user?, allowTcpForwarding? })`. Ledger řádky `Task 1: gate docker29 = PASS|FAIL`, `Task 1: gate zero-downtime = PASS|FAIL`, `Task 1: regenerate command = <přesný příkaz>`.

- [ ] **Step 1: Varianta fake serveru s Dockerem 29.** `get.docker.com --version <ver>` s nejnovější dostupnou 29.x (zjisti `apt-cache madison`/web, zapiš do ledgeru). Obraz se staví jen při chybějícím tagu, proto se tag mění.
- [ ] **Step 2: Napiš `proxy-gate.test.ts`** se třemi bloky. Všechny nastavují proxy přes **MUP** (`mup setup` + `mup deploy`), takže nezávisí na kódu comet-deploy:
  - **(a) `docker29`:** pro Docker 27.5 i 29.x config se `proxy: { domains: 'app.test' }`. Zkontroluj:
    - `curl -s -H 'Host: app.test' http://localhost/` uvnitř fake serveru vrátí stránku ukázkové aplikace,
    - `docker exec mup-nginx-proxy cat /etc/nginx/conf.d/default.conf` obsahuje IP kontejneru aplikace,
    - `docker logs mup-nginx-proxy-letsencrypt` neobsahuje `client version` ani `too old`.
  - **(b) `zero-downtime prototype`** (Docker 27.5):
    - Smyčka `curl` každých 50 ms přes proxy běží na fake serveru na pozadí.
    - Shell v testu provede ruční přepnutí podle hlavního specu §10.2: z `config/start.sh` odvodí skript pro `<name>-next`, spustí ho a provede health check. Pak čeká, až je nová IP v `default.conf`, spustí `docker stop -t 10 <name>`, `docker rm <name>` a `docker rename <name>-next <name>`.
    - Očekávání: 0 neúspěšných požadavků (chyba spojení nebo status ≥ 500).
  - **(c) `regenerate`:** zjisti, jak image spouští docker-gen (`docker exec mup-nginx-proxy cat /app/Procfile`). Pak ověř příkaz pro jedno nové vygenerování bez restartu kontejneru (kandidát: `docker exec mup-nginx-proxy docker-gen -notify "nginx -s reload" /app/nginx.tmpl /etc/nginx/conf.d/default.conf`): po vytvoření `vhost.d/app.test_location` a spuštění příkazu obsahuje `default.conf` řádek `include /etc/nginx/vhost.d/app.test_location;` a `StartedAt` kontejneru se nezměnil.
- [ ] **Step 3: Spusť bránu.** Run: `npx vitest run -c vitest.integration.config.ts test/integration/proxy-gate.test.ts`. Expected: tři zelené bloky.
- [ ] **Step 4: Vyhodnoť.**
  - **(a) FAIL na Dockeru 29:** **STOP.** Nepokračuj dalším úkolem. Uživateli předlož, co přesně selhalo (chybová hláška, která komponenta), a možnosti podle spec §6. Rozhodne uživatel.
  - **(b) FAIL:** nejdřív hledej příčinu (systematic-debugging). Pokud nulový výpadek s MUP šablonou spolehlivě nejde, ledgeruj `Task 1: Ruling: zero-downtime fallback (hlavní spec §10.2)`. Úkol 6 pak implementuje jen `zeroDowntimeBlocker`, který vždy vrátí důvod, a dokumentace (úkol 9) to uvede.
  - **(c) FAIL:** najdi jiný spouštěč bez restartu proxy kontejnerů a ledgeruj ho.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "test: proxy gate (Docker 29, zero-downtime prototype, nginx regeneration)"`

---

### Task 2: MUP šablony proxy, renderery a maskování

**Files:**
- Create: `templates/mup/proxy/**` (kopie `node_modules/mup/lib/plugins/proxy/assets/**`), `src/proxy/render.ts`
- Modify: `src/output/secrets.ts` (`collectSecrets` + `proxy.shared.env`, `proxy.shared.envLetsEncrypt`), `NOTICE` (zmínka o šablonách proxy, pokud tam MUP šablony nejsou uvedené obecně)
- Test: `test/unit/proxy/render.test.ts`, `test/unit/output/secrets.test.ts`

**Interfaces:**
- Produces (`src/proxy/render.ts`):
  ```ts
  export const PROXY_NAME = 'mup-nginx-proxy';
  export const PROXY_DIR = '/opt/mup-nginx-proxy';
  export function proxyServers(c: NormalizedConfig, filter: string[] | null): string[]; // keys of proxy.servers, else app.servers (MUP getSessions), filtered by --servers
  export function proxyDomains(c: NormalizedConfig): string[];                       // proxy.domains.split(',') without trim, as in MUP
  export function loadBalancingHosts(c: NormalizedConfig): string[];                 // privateIp || host of ALL app servers, in app.servers order
  export function lbPort(c: NormalizedConfig): number;                               // app.env.PORT after normalization
  export function renderProxySetupSh(c: NormalizedConfig): Promise<string>;
  export function renderProxyStartSh(c: NormalizedConfig): Promise<string>;          // templates/start.sh → /opt/mup-nginx-proxy/config/start.sh
  export function readNginxTmpl(): Promise<string>;                                  // nginx.tmpl verbatim
  export function renderNginxConfigSh(c: NormalizedConfig, basePath: string): Promise<string>;
  export function renderSslCleanupSh(c: NormalizedConfig): Promise<string>;
  export function renderSslSetupSh(c: NormalizedConfig): Promise<string>;
  export function renderServiceConfigureSh(c: NormalizedConfig): Promise<string>;
  export function renderProxyStopSh(): Promise<string>;
  export function renderProxyStartScript(): Promise<string>;                         // proxy-start.sh
  export function customCertFiles(c: NormalizedConfig, basePath: string): { crt: string; key: string } | null; // only when ssl.crt, no letsEncryptEmail, upload !== false
  export interface SharedFiles { sharedConfigSh: string; envList: string; envLetsEncryptList: string; nginxDefaultConf: string; template: string | null }
  export function renderSharedFiles(c: NormalizedConfig, o: { basePath: string; cwd: string }): Promise<SharedFiles>; // templatePath is cwd-relative (ref. §2.4)
  export function vhostContent(c: NormalizedConfig, basePath: string): { server: string; location: string | null }; // exactly what nginx-config.sh writes per domain
  ```
  A file that cannot be read → `CometError` naming the config key and the path.

- [ ] **Step 1: Write the failing tests.**
  - Každý soubor v `templates/mup/proxy/**` je bajtově shodný s `node_modules/mup/lib/plugins/proxy/assets/**` a žádný nechybí.
  - **Orákulum:** pro fixture `proxy-le` a `proxy-lb` a nové fixture `proxy-certs` (`ssl.crt`/`ssl.key`, `nginxServerConfig`, `nginxLocationConfig`, `clientUploadLimit: '50M'`) a `proxy-shared` (`shared.httpPort`, `shared.env.DEFAULT_HOST`, `shared.envLetsEncrypt.ACME_CA_URI`, `shared.nginxConfig`, `shared.templatePath`) se výstup každého `render*` rovná `ejs.render` MUP assetu s proměnnými, které by předal `command-handlers.js` (config z `mupNormalize`).
  - `vhostContent` se rovná tomu, co zapíše `bash` vyrenderovaného `nginx-config.sh` (test ho spustí lokálně v dočasném adresáři s cestou přepsanou na tmp).
  - `proxyServers` bez `proxy.servers` vrací servery aplikace a s `--servers one` jen `one`. `loadBalancingHosts(proxy-lb)` → `['10.0.0.1', '10.0.0.2']`. `proxyDomains` pro `'a.com, b.com'` → `['a.com', ' b.com']` (parita s MUP).
  - Chybějící soubor `nginxServerConfig` → `CometError` obsahující `proxy.nginxServerConfig` a cestu.
  - `collectSecrets` obsahuje hodnotu `shared.env.SECRET_TOKEN` (`'shared-secret-1'`) a hodnotu `shared.envLetsEncrypt.KEY` (`'le-secret-123'`).
- [ ] **Step 2: Run tests to verify they fail.** Run: `npx vitest run test/unit/proxy/render.test.ts test/unit/output/secrets.test.ts`. Expected: FAIL (modul neexistuje).
- [ ] **Step 3: Zkopíruj šablony a implementuj renderery.** Šablony se kopírují příkazem `cp -R node_modules/mup/lib/plugins/proxy/assets/. templates/mup/proxy/`. Vstupy funkcí jsou podle `command-handlers.js` (`setup`, `reconfigShared`, `updateProxyForLoadBalancing`). `swarmEnabled` je vždy `false`.
- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(proxy): MUP proxy templates and renderers"`

---

### Task 3: Model upstreamu a řadič vyřazování

**Files:**
- Create: `src/proxy/upstream.ts`
- Test: `test/unit/proxy/upstream.test.ts`

**Interfaces:**
- Consumes: `loadBalancingHosts`, `lbPort` (úkol 2).
- Produces:
  ```ts
  export interface UpstreamEntry { host: string; port: number; down: boolean }
  export function desiredEntries(c: NormalizedConfig): UpstreamEntry[];                 // MUP order, all up
  export function formatUpstream(c: NormalizedConfig, entries: UpstreamEntry[]): string; // byte-identical to MUP's heredoc when no entry is down
  export function parseUpstream(content: string): UpstreamEntry[];                       // tolerant of MUP's blank lines and ip_hash
  export interface UpstreamApply { (content: string): Promise<{ failed: Array<{ proxy: string; error: string }> }> }
  export class UpstreamController {
    constructor(c: NormalizedConfig, current: UpstreamEntry[], apply: UpstreamApply, o: { waitMs?: number });
    /** Marks the server down (and waits DRAIN_WAIT_MS); false when that would leave no entry up or it has no entry. */
    drain(server: string): Promise<boolean>;
    /** The server passed its health check: its entry becomes host(s):port(new config), up. */
    healthy(server: string): Promise<void>;
    /** Final form: desiredEntries, with `down` kept for servers in `keepDown`. Removes stale entries. */
    finalize(keepDown: ReadonlySet<string>): Promise<void>;
    /** Servers whose entry is down right now. */
    downServers(): string[];
    /** Proxies where an apply failed, for the summary. */
    failures(): Array<{ proxy: string; error: string }>;
  }
  ```
  Pravidla řadiče (spec §4.2 a §4.4):
  - Položka patří serveru, když se shoduje host (`privateIp || host`). Port se smí lišit.
  - Položky, jejichž host nepatří žádnému serveru configu, jsou zastaralé. Odstraní se při prvním zápisu, pokud tím nezmizí poslední položka nahoře. Jinak se odstraní až ve `finalize`.
  - Server bez položky (nový server, změněná adresa) se přidá až v `healthy()`, na pozici podle pořadí `app.servers`.
  - Zápisy jsou serializované (jeden zápis naráz, souběžné `drain` z paralelní dávky se řadí).
  - Všechny zápisy jdou přes `apply`. Selhání na některé proxy se zaznamená a nevyhodí se.

- [ ] **Step 1: Write the failing tests.**
  - `formatUpstream(proxy-lb, desiredEntries(proxy-lb))` se rovná tělu heredocu z MUP `upstream.sh` vyrenderovaného orákulem. Tělo se získá spuštěním heredocu přes `bash` do dočasného souboru. Totéž se `stickySessions: true` (řádek `ip_hash;`).
  - `parseUpstream(formatUpstream(...))` vrátí stejné položky. Řádek `server 10.0.0.1:4000 down;` → `{ host: '10.0.0.1', port: 4000, down: true }`.
  - Řadič se dvěma servery: `drain('one')` → `true`, `apply` dostal obsah s `server 10.0.0.1:<port> down;`. Pak `drain('two')` → `false` (byl by to poslední), `apply` se nevolal znovu.
  - Řadič s `one` už `down` z dřívějška: `drain('two')` → `false`.
  - Změna portu: aktuální `10.0.0.1:4000`, `10.0.0.2:4000`, config má `PORT 5000`. Po `drain('one')` a `healthy('one')` obsahuje poslední apply `10.0.0.1:5000` nahoře a `10.0.0.2:4000` nahoře.
  - Odebraný server `10.0.0.3:4000` zmizí při prvním zápisu. Přidaný server se objeví až po `healthy`.
  - `finalize(new Set(['two']))` → MUP tvar, jen `two` má ` down`. `finalize(new Set())` → bajtově MUP tvar.
  - Dva souběžné `drain` (`Promise.all`) → `apply` se nikdy nevolá souběžně (měřeno počítadlem).
  - `apply`, které vrátí `failed: [{ proxy: 'p2', … }]` → `failures()` ho obsahuje a `drain` vrátí `true` (vyřazeno aspoň na zbylých proxy).
  - `waitMs: 0` v testech, výchozí `DRAIN_WAIT_MS = 5000`.
- [ ] **Step 2: Run tests to verify they fail.** Run: `npx vitest run test/unit/proxy/upstream.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implementuj `src/proxy/upstream.ts`.**
- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(proxy): upstream model with down marks and drain controller"`

---

### Task 4: Synchronizace souborů proxy pro aplikaci a nové vygenerování nginx konfigurace

**Files:**
- Create: `src/proxy/sync.ts`, `templates/comet/proxy-state.sh`, `templates/comet/proxy-upstream.sh`, `templates/comet/proxy-regenerate.sh`
- Test: `test/unit/proxy/sync.test.ts`

**Interfaces:**
- Consumes: úkoly 2 a 3. Příkaz regenerace z ledgeru úkolu 1.
- Produces:
  ```ts
  export interface ProxyFileState {
    vhost: Record<string, string | null>;          // domain → sha256 of vhost.d/<domain> (null = missing)
    location: Record<string, string | null>;       // domain → sha256 of vhost.d/<domain>_location
    cert: { crt: string | null; key: string | null; linkedDomains: string[] }; // sha256 of /opt/<app>/config/bundle.crt|private.key, domains with certs/<d>.crt link
    upstream: string | null;                       // content of upstream/<app>
    upstreamLinks: string[];                       // domains with vhost.d/<d>_upstream
    serviceScript: string | null;                  // content of /opt/<app>/config/proxy-config-container.sh
    serviceRunning: boolean;
    proxyRunning: boolean;                         // container mup-nginx-proxy is running
  }
  export interface DesiredProxyFiles { vhost: { server: string; location: string | null }; certs: { crt: string; key: string } | null; lb: boolean; serviceScript: string | null }
  export type LbTransition = 'none' | 'enable' | 'disable' | 'keep';
  export interface ProxySyncPlan {
    before: Array<'vhost' | 'certs' | 'lb-remove'>;
    after: Array<'lb-enable' | 'service'>;
    regenerate: { before: boolean; after: boolean };
    lbTransition: LbTransition;
    changes: string[];                             // human-readable, for the output
  }
  export function desiredProxyFiles(c: NormalizedConfig, basePath: string): Promise<DesiredProxyFiles>; // throws CometError for unreadable files (Review Focus 5)
  export function readProxyFileState(conn: SshConnection, c: NormalizedConfig): Promise<ProxyFileState>;
  export function planProxySync(desired: DesiredProxyFiles, current: ProxyFileState, domains: string[]): ProxySyncPlan; // pure
  export function applyProxySync(conn: SshConnection, c: NormalizedConfig, basePath: string, plan: ProxySyncPlan, phase: 'before' | 'after', out?: ExecOptions): Promise<void>;
  export function writeUpstreamFile(conn: SshConnection, c: NormalizedConfig, content: string | null, out?: ExecOptions): Promise<void>; // null = remove file + links (MUP cleanup steps)
  export function regenerateNginx(conn: SshConnection, out?: ExecOptions): Promise<void>;
  ```
  - `applyProxySync` provádí kroky **MUP skripty z úkolu 2**:
    - `vhost` → `nginx-config.sh`,
    - `certs` → `ssl-cleanup.sh`, SFTP crt/key do `/opt/<app>/config/bundle.crt` a `private.key` (key s módem `0o600`) a `ssl-setup.sh`,
    - `service` → `service-configure.sh`.
  - Upstream zapisuje `writeUpstreamFile` přes `proxy-upstream.sh`. Ten dělá kroky `upstream.sh` (rm souboru, `find . -xtype l -delete` v kontejneru, zápis, `ln -s` odkazů, `nginx -s reload`), jen s obsahem dodaným zvenku, a všechno se `sudo`.
  - `lbTransition`: `enable` = config má LB a server nemá `upstreamLinks`, `disable` = opak, `keep` = LB v obou, `none` = bez LB v obou. Obsah upstreamu při `keep` řeší řadič (úkol 3), ne tento plán.

- [ ] **Step 1: Write the failing tests.**
  - `planProxySync` bez rozdílů → prázdné `before`/`after`, `regenerate` obojí `false`, `changes: []`.
  - Jiný hash `vhost` jedné domény → `before: ['vhost']`, `regenerate.before === false`, protože soubor existoval a mění se jen obsah. Chybějící vhost soubor (nová doména) → `regenerate.before === true`.
  - Přidaný `nginxLocationConfig` → `before: ['vhost']`, `regenerate.before: true`. Odebraný → totéž.
  - Jiný hash certifikátu → `before: ['certs']`, `regenerate.before: true`.
  - LB `enable` → `after: ['lb-enable', 'service']`, `regenerate.after: true`, nic v `before`. LB `disable` → `before: ['lb-remove']`, `regenerate.before: true`.
  - `keep` s jiným `serviceScript` → `after: ['service']`.
  - `desiredProxyFiles` s chybějícím `ssl.key` → `CometError` s `proxy.ssl.key` a cestou.
  - `readProxyFileState` s mock spojením parsuje výstup `proxy-state.sh` (formát `key=value`, hash `-` = chybí, víceřádkový obsah upstreamu je base64).
  - `applyProxySync(phase: 'before')` s mock spojením: pro `certs` posílá klíč přes `writeFile(…, 0o600)` a jeho obsah se neobjeví v žádném `exec`/`runScript`.
- [ ] **Step 2: Run tests to verify they fail.** Run: `npx vitest run test/unit/proxy/sync.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implementuj** `src/proxy/sync.ts` a tři skripty v `templates/comet/`. `proxy-regenerate.sh` obsahuje příkaz z ledgeru úkolu 1.
- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(proxy): sync the app's proxy files and regenerate the nginx config"`

---

### Task 5: Příkazy `proxy *`, proxy v `setup` a `status`, restart proxy jen při změně

**Files:**
- Create: `src/proxy/setup.ts`, `src/cli/commands/proxy.ts`, `templates/comet/proxy-inputs.sh`, `templates/comet/proxy-status.sh`
- Modify:
  - `src/cli/registry.ts` (`CommandGroup` + `'proxy'`, popis `'Reverse proxy commands'`),
  - `src/cli/main.ts` (registrace `PROXY_COMMANDS`),
  - `src/cli/commands/phase2.ts` (zástupný příkaz `proxy` pryč),
  - `src/cli/commands/setup.ts` (`setupAll`: varování pro proxy pryč, kroky `proxy.setup`),
  - `src/cli/commands/status.ts` (`default.status` připojí `proxy.status`),
  - `src/remote/ops.ts` (`SetupMissingError extends CometError` pro oba případy „config dir chybí“ v `acquireLock`),
  - `src/deploy/pipeline.ts` (`lockServers(…, o: { force?: boolean; skipNotSetUp?: boolean })`)
- Test: `test/unit/proxy/setup.test.ts`, `test/unit/cli/proxy.test.ts`, `test/unit/cli/setup.test.ts`, `test/unit/deploy/pipeline.test.ts` (jen nový případ `skipNotSetUp`)

**Interfaces:**
- Consumes: úkoly 2, 3 a 4.
- Produces:
  ```ts
  // src/proxy/setup.ts
  export function proxySetup(ctx: CommandContext): Promise<void>;      // runner key 'proxy.setup', then 'proxy.start' (only if needed), then LB 'post.proxy.setup' part
  export function proxyStart(ctx: CommandContext, o: { force: boolean }): Promise<void>; // key 'proxy.start'; force = always recreate (the `proxy start` command)
  export function proxyStop(ctx: CommandContext): Promise<void>;
  export function proxyReconfigShared(ctx: CommandContext): Promise<void>;
  export function proxyInputsDigest(conn: SshConnection): Promise<{ digest: string; running: boolean }>; // sha256 of start.sh, shared-config.sh, env.list, env_letsencrypt.list, nginx-default.conf, nginx.tmpl, nginx-shared.tmpl (or "-") + both containers running
  export interface ProxyStatusRow { server: string; nginx: string; letsEncrypt: string; httpPort?: string; httpsPort?: string; certificates: Record<string, string>; downServers: string[]; outOfSync: string[] }
  export function proxyStatus(ctx: CommandContext): Promise<ProxyStatusRow[]>;
  export function formatProxyStatus(rows: ProxyStatusRow[]): string;    // MUP's "=> Reverse Proxy Status" layout + "Drained: …" / "Out of sync: …" lines
  // src/cli/commands/proxy.ts
  export const PROXY_COMMANDS: CommandModule[]; // setup, start, stop, reconfig-shared, logs, logs-le, nginx-config, status, envconfig (error)
  ```
  - **Zámek (spec §4.6):** `proxy setup`, `proxy start`, `proxy stop` a `proxy reconfig-shared` volají `lockServers(ctx, allAppServers, 'proxy …', d, { skipNotSetUp: true })`. `allAppServers` jsou všechny klíče `app.servers` bez ohledu na `--servers`. Zámek se uvolní ve `finally`.
  - **`setup`:** `docker.setup` → `meteor.setup` → zámek → `proxy.setup` (MUP `post.setup`) → odemknutí.
  - **Restart proxy jen při změně (spec §4.1):** před nahráním souborů se přečte `proxyInputsDigest` a po nahrání znovu. `proxy-start.sh` se spustí, když se digest liší, když kontejnery neběží, nebo když `force`. Jinak se vypíše `[server] proxy up to date`. `reconfig-shared` a `start` běží sériově, `setup` paralelně (ref. §3.6).
  - **Upstream v `proxy setup`** se nezapisuje MUP `upstream.sh`, ale přes `writeUpstreamFile` s obsahem `formatUpstream(c, entries)`, kde se ze současného souboru převezmou značky `down` (spec §4.1). Bez LB se volá `writeUpstreamFile(conn, c, null)`.
  - **`logs`/`logs-le`:** předávání voleb jako `streamLogs` ve fázi 1. `logs-le` běží na serverech aplikace (MUP `getSessions(['app'])`).
  - **`envconfig`:** `CometError('"proxy envconfig" has no implementation in MUP 1.5.11 either: it is listed in its help, but running it fails.')`.

- [ ] **Step 1: Write the failing tests.**
  - `proxySetup` s mock poolem (zaznamenává skripty a `writeFile` po serverech):
    - pořadí: `proxy-setup.sh` → `start.sh` → `nginx.tmpl` → `nginx-config.sh` → `ssl-cleanup.sh` → (certs) → upstream → digest → `proxy-start.sh`,
    - pro proxy-lb ještě `service-configure.sh`,
    - obsahy jsou z úkolu 2.
  - Druhý `proxySetup` se stejným digestem a běžícími kontejnery `proxy-start.sh` nespustí a vypíše `proxy up to date`. `proxyStart({ force: true })` ho spustí vždy.
  - Upstream s `server 10.0.0.2:… down;` na serveru → `proxySetup` zapíše obsah se stejnou značkou.
  - `setupAll` pro config s proxy: pořadí runner klíčů `default.setup`, `docker.setup`, `meteor.setup`, `proxy.setup`, `proxy.start`. Už žádné varování „not set up yet“.
  - `lockServers(…, { skipNotSetUp: true })`: server, kde `acquireLock` vyhodí `SetupMissingError`, se přeskočí a nevrátí se v seznamu zamčených. Jiná chyba se hlásí jako dřív.
  - `proxy envconfig` → exit code 1 a uvedená hláška. `proxy --help` vypíše všech 9 příkazů. MUP má `envconfig` v nápovědě viditelný (`commands.js`), proto ho comet-deploy ukazuje s popisem `Configure environment variables for proxy (not implemented in MUP 1.5.11)`.
  - `formatProxyStatus` pro jeden server s certifikátem `a.com.chain.pem` a `downServers: ['two']` obsahuje řádky `- Status: running`, `- HTTP: 80`, `- a.com.chain.pem: <datum>` a `Drained: two (run "comet-deploy restart --servers two" once it is healthy)`.
  - `status` s proxy configem volá po tabulce aplikace `proxy.status` (runner historie).
- [ ] **Step 2: Run tests to verify they fail.** Run: `npx vitest run test/unit/proxy/setup.test.ts test/unit/cli/proxy.test.ts test/unit/cli/setup.test.ts test/unit/deploy/pipeline.test.ts`. Expected: nové případy FAIL.
- [ ] **Step 3: Implementuj.**
- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(proxy): proxy commands, proxy setup and status, restart the proxy only on change"`

---

### Task 6: Přepnutí bez výpadku za proxy (spec §4.3)

**Files:**
- Create: `src/deploy/zero-downtime.ts`, `templates/comet/zd-start.sh`, `templates/comet/zd-finish.sh`
- Modify: `src/deploy/activate.ts` (`activateServer` a `startServer` dostanou `o.switch?: SwitchMode`; `revertServer` dostane `o.restart: boolean`)
- Test: `test/unit/deploy/zero-downtime.test.ts`, `test/unit/deploy/activate.test.ts`

**Interfaces:**
- Consumes: úkol 2 (`PROXY_NAME`), ledger úkolu 1 (výsledek brány b).
- Produces:
  ```ts
  export type SwitchMode = { kind: 'zero-downtime' } | { kind: 'restart' };
  export function zeroDowntimeBlocker(c: NormalizedConfig): string | null; // null = allowed; else a one-line reason
  export function nextContainerScript(startSh: string): string;           // throws CometError('config/start.sh has an unknown form …') when an anchor is missing
  export function switchContainer(d: Pick<ActivateDeps, 'conn' | 'config' | 'serverName' | 'reporter'>, out: ExecOptions): Promise<{ health: HealthResult; switched: boolean }>;
  ```
  - **`zeroDowntimeBlocker`** vrací důvod, když platí aspoň jedno z:
    - bez `proxy`,
    - `proxy.loadBalancing`,
    - `cometDeploy.zeroDowntime === false`,
    - `docker.args` obsahuje `-p`/`--publish`/`-P`/`--publish-all`, `--network host`, `--net host` nebo `--net=host`/`--network=host`, nebo `--name`,
    - `docker.networks` obsahuje `host`,
    - brána (b) v úkolu 1 selhala (pak vždy `'zero-downtime switch is not available with the MUP proxy (see docs/how-it-works.md)'`).
  - **`nextContainerScript`** vezme text `config/start.sh` ze serveru a:
    - odstraní blok od `# Remove previous version of the app, if exists` po `>&2 echo "Finished removing docker containers"`,
    - nahradí `--name=$APPNAME` za `--name=$APPNAME-next`,
    - u řádků `docker network connect <net> $APPNAME` nahradí `$APPNAME` za `$APPNAME-next`.

    Ostatní (`--hostname="$HOSTNAME-$APPNAME"`, env, volumes, log options, cesty) zůstane beze změny.
  - **`switchContainer`:**
    1. `docker rm -f <name>-next` (zbytek po dřívějším pádu).
    2. Housekeeping image módu z `meteor-start.sh` (`rm -rf current`, `rm -rf last`, když existuje `:previous`).
    3. `nextContainerScript` + spuštění.
    4. Health check na kontejneru `<name>-next` (stejné volby jako dnes, jen jiné jméno kontejneru).
    5. Při úspěchu čekání (≤ `NGINX_PICKUP_TIMEOUT_MS`), až `docker exec mup-nginx-proxy cat /etc/nginx/conf.d/default.conf` obsahuje `<IP next>:<imagePort>`. Když se tam neobjeví, je to selhání.
    6. Pak `zd-finish.sh`: `docker stop -t 10 <name>`, `docker rm <name>`, `docker rename <name>-next <name>`.
    7. Při selhání `docker rm -f <name>-next` a `switched: false`.
  - **`activateServer`:**
    - S `switch.kind === 'zero-downtime'` volá místo `startAndCheck` `switchContainer`.
    - Při neúspěchu volá `revertServer(d, { tags, restoreConfig, restart: false })`. Starý kontejner běží dál, takže health check obnovené verze proběhne na `<name>` a výsledek je `reverted`.
    - Logy se při selhání čtou z `<name>-next` před jeho odstraněním.
  - **`startServer`** (restart) se `switch.kind === 'zero-downtime'` volá `switchContainer` místo `meteor-start.sh` a pipeline předtím nespouští stop skript (úkol 7).

- [ ] **Step 1: Write the failing tests.**
  - `nextContainerScript(await renderStartSh(c, s))` pro fixture `proxy-le`, `aaa-like` a `per-server-env` (config s přidanou proxy):
    - výsledek neobsahuje `docker rm -f $APPNAME\n`,
    - obsahuje `--name=$APPNAME-next`,
    - každý `network connect` míří na `$APPNAME-next`,
    - po zpětné náhradě `$APPNAME-next` → `$APPNAME` a vrácení odstraněného bloku je text shodný s původním (žádná jiná změna).
  - `nextContainerScript('#!/bin/bash\necho hi\n')` → `CometError` s `unknown form`.
  - `zeroDowntimeBlocker`:
    - `proxy-le` → `null`,
    - `proxy-lb` → důvod obsahuje `loadBalancing`,
    - `docker.args: ['-p 9000:9000']` → důvod obsahuje `publishes a host port`,
    - `zeroDowntime: false` → důvod,
    - bez proxy → důvod.
  - `activateServer` s mock spojením, `switch: zero-downtime`:
    - **health OK:** pořadí snapshot → retag → zápis souborů → `rm -f <name>-next` → `zd-start` → health na `<name>-next` → čtení `default.conf` → `zd-finish` → `healthy`. `meteor-start.sh` se nespustí.
    - **health FAIL:** `docker logs … <name>-next`, `rm -f <name>-next`, obnovení snapshotu a tagů, **žádné** `start.sh`, health na `<name>` → `reverted`.
    - **nová IP se v `default.conf` neobjeví do timeoutu** (v testu 0 ms) → selhání se stejným návratem.
- [ ] **Step 2: Run tests to verify they fail.** Run: `npx vitest run test/unit/deploy/zero-downtime.test.ts test/unit/deploy/activate.test.ts`. Expected: nové případy FAIL.
- [ ] **Step 3: Implementuj.** Timeout `NGINX_PICKUP_TIMEOUT_MS` jde v testech přepsat volbou (ne env proměnnou).
- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS, staré případy `activate.test.ts` beze změny.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(deploy): zero-downtime switch behind the proxy"`

---

### Task 7: Proxy v pipelines: preflight, synchronizace, vyřazování, zámky, souhrn

**Files:**
- Create: `src/proxy/rollout.ts`
- Modify:
  - `src/deploy/pipeline.ts`:
    - `assertPhase1Supported` už neodmítá `proxy`,
    - `deployPipeline`, `reconfigPipeline`, `restartPipeline`, `rollbackPipeline` a `lockedRollout` obalí aktivaci `ProxyRollout`,
    - pro LB se zamykají všechny servery aplikace,
    - `PipelineDeps` + `createProxyRollout`,
  - `src/deploy/preflight.ts` (vstup `proxyServers`, fakt `proxyRunning`, chyba „proxy not set up“),
  - `src/cli/commands/setup.ts` (nic dalšího, jen pokud to vyžaduje typ)
- Test: `test/unit/proxy/rollout.test.ts`, `test/unit/deploy/pipeline.test.ts`, `test/unit/deploy/preflight.test.ts`

**Interfaces:**
- Consumes: úkoly 3, 4, 5 a 6.
- Produces:
  ```ts
  export interface ProxyRollout {
    /** deploy/reconfig: desired files + 'before' part of the sync on every proxy server, regenerate when the plan says so. */
    prepare(): Promise<void>;
    /** Wraps one server's activation: picks the SwitchMode, drains (LB), runs, marks healthy or keeps it down. */
    activate(server: string, run: (mode: SwitchMode) => Promise<ActivationResult>): Promise<ActivationResult>;
    /** After the strategy (also after an abort): 'after' part of the sync, UpstreamController.finalize, returns warnings for the summary. Never throws. */
    finish(results: ActivationResult[]): Promise<string[]>;
  }
  export function createProxyRollout(ctx: CommandContext, o: { action: 'deploy' | 'reconfig' | 'rollback' | 'restart'; strategy: Strategy }): Promise<ProxyRollout | null>; // null without `proxy`
  export function lockTargets(ctx: CommandContext): string[]; // LB: every app.servers key; else ctx.appServers()
  ```
  - **`prepare`** běží jen u `deploy` a `reconfig`:
    - u deploye **před buildem** spočte `desiredProxyFiles` (chyby souborů padnou před buildem, Review Focus 5),
    - **po zámku a před aktivací** provede `before` část na všech proxy serverech (`proxyServers(c, null)`).
  - **Varování o sdíleném nastavení** (spec §4.2) jen když `c.proxy.shared` existuje. Porovnání podle účinku: `nginx-default.conf` bez řádku `client_max_body_size …;`, který připisuje proxy `start.sh`, ostatní soubory přesně.
  - **Výběr `SwitchMode`:** `zero-downtime`, když `zeroDowntimeBlocker(c) === null`, jinak `restart`. Důvod se vypíše jednou: `Zero-downtime switch not used: <reason>`.
  - **`UpstreamController`** (úkol 3) vzniká jen při `lbTransition === 'keep'`. Inicializuje se z `readProxyFileState(...).upstream` prvního dosažitelného proxy serveru a `apply` zapisuje `writeUpstreamFile` na všechny proxy servery. Stav proxy se čte i u `rollback` a `restart`, ty ale nic nesynchronizují. Při `enable` zapíše upstream část `after`, při `disable` a `none` se upstream nevede.
  - **Vyřazování:** jen u LB s `zeroDowntime !== false`, se strategií jinou než `parallel` a s více než jedním serverem. `drain` → `run('restart')`. Při `healthy` řadič `healthy(server)`. Při `reverted` řadič `healthy(server)` (obnovený server prošel health checkem). Při `revert-failed`/`failed` zůstane `down`.
  - **Abort (Ctrl+C):** `finish` se volá i po abortu (pipelines ho mají ve `finally` před `releaseServers`).
  - **`finish`:**
    - spustí `after` část (LB `enable` jen když jsou všechny cílové servery `healthy`, jinak varování `loadBalancing was not enabled on the proxies because <servers> did not deploy; run the deploy again`),
    - spustí `finalize(keepDown)`,
    - vrátí varování: servery, které zůstaly `down`, s příkazem `comet-deploy restart --servers <s>`, a proxy, kde zápis selhal.

    Pipelines je vypíšou přes `ctx.reporter.warn` po `reportOutcome`.
  - **LB `disable` s `proxy.servers`**, které nejsou servery aplikace → `CometError` před buildem: `Turning off loadBalancing while the proxy runs on servers without the app would leave those proxies without a backend. Remove proxy.servers first or keep loadBalancing.`
  - **Preflight:** `runPreflight(ctx, servers, { …, proxyServers: string[] })`. Proxy server bez běžícího `mup-nginx-proxy` → chyba `Server "<s>": the reverse proxy is not set up (container mup-nginx-proxy is missing or stopped). Run "comet-deploy proxy setup" first.`. Proxy servery se kontrolují jen u `deploy`, `reconfig`, `rollback` a `restart`.

- [ ] **Step 1: Write the failing tests.**
  - `createProxyRollout` bez `proxy` → `null` a pipelines se chovají jako dosud (všechny stávající testy `pipeline.test.ts` beze změny).
  - `deployPipeline` s proxy-le a mock deps: pořadí `preflight` (s `proxyServers: ['one']`) → `desiredProxyFiles` → build → lock → distribute → `prepare` (before sync) → `activateServer({ switch: zero-downtime })` → `finish` → unlock.
  - `deployPipeline` s chybějícím `nginxServerConfig` → `CometError` a `buildApp` se nevolal.
  - **proxy-lb, canary, 2 servery:** pořadí `drain(one)` → activate one → `healthy(one)` → `drain(two)` → activate two → `healthy(two)` → `finalize(∅)`. Strategie `parallel` → žádný `drain`.
  - **proxy-lb, `revert-failed` na `two`:** `finalize(new Set(['two']))` a varování obsahuje `comet-deploy restart --servers two`.
  - **Abort po activate `one`** (Review Focus 3): `finish` se zavolal, `one` je nahoře, `two` zůstal v `skipped` a nebyl vyřazen.
  - **`apply` vyhodí pro jednu proxy** (Review Focus 4): deploy pokračuje, varování jmenuje tu proxy.
  - **LB zámek:** `deploy --servers one` s proxy-lb zamkne `one` i `two`.
  - **LB enable** (server bez `upstreamLinks`, config s LB): upstream se zapíše až ve `finish`, a jen když jsou všechny servery `healthy`.
  - **`restartPipeline` se zero-downtime:** nespustí stop skript a volá `startServer({ switch: zero-downtime })`.
  - **`evaluatePreflight`** s `proxyServers: { one: { proxyRunning: false } }` → chyba s `comet-deploy proxy setup`.
- [ ] **Step 2: Run tests to verify they fail.** Run: `npx vitest run test/unit/proxy/rollout.test.ts test/unit/deploy/pipeline.test.ts test/unit/deploy/preflight.test.ts`. Expected: nové případy FAIL.
- [ ] **Step 3: Implementuj.** `createProxyRollout` dostává I/O přes `PipelineDeps`, aby šel testovat bez SSH. Existující `assertPhase1Supported` dál odmítá `mongo`, `privateDockerRegistry` a transporty `registry`/`stream`.
- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(deploy): proxy-aware rollouts (file sync, drain, zero-downtime, locks)"`

---

### Task 8: Integrační testy proxy (napsat teď, spustit v úkolu 10)

**Files:**
- Create: `test/harness/pebble.ts`, `test/integration/proxy.test.ts`, `test/integration/proxy-lb.test.ts`
- Modify: `test/integration/interop.test.ts` (proxy scénáře), `test/integration/helpers.ts` (`curlVia(server, host, path)`, `requestLoop(server, host)` → `{ stop(): Promise<{ total: number; failed: number }> }`)

**Interfaces:**
- Consumes: všechny předchozí úkoly. Harness z úkolu 1.
- Produces: `startPebble(server: FakeServer): Promise<{ acmeUri: string; caPath: string }>`. Pebble běží v Dockeru fake serveru.

  **Návrh přístupu [ruling, smí se změnit s ledgerem]:**
  - `PEBBLE_VA_ALWAYS_VALID=1`, takže není potřeba DNS.
  - CA Pebble se uloží do `/opt/mup-nginx-proxy/mounted-certs/pebble-ca.pem`. Companion ji díky `--volumes-from` vidí jako `/etc/nginx/certs/pebble-ca.pem`.
  - Companion se na ni nasměruje přes `shared.envLetsEncrypt` (`ACME_CA_URI`, případně `REQUESTS_CA_BUNDLE`/`CA_BUNDLE` podle toho, co v1.13.1 čte).

  Pokud vydání s v1.13.1 nejde rozchodit, minimum je: companion kontejner aplikace vidí a kontaktuje `ACME_CA_URI` (z logů). Takové rozhodnutí se ledgeruje jako `Ruling` s cenou „vydání certifikátu není ověřené“ a uvede se v předání.

- [ ] **Step 1: Napiš `proxy.test.ts`** (1 fake server, `user: 'deployer'`, Review Focus 2):
  1. `setup` s `proxy: { domains: 'app.test', ssl: { letsEncryptEmail: 'a@app.test' }, shared: { envLetsEncrypt: {…Pebble…} } }`.
  2. `deploy`: `curlVia(s1, 'app.test', '/')` odpoví aplikací a `proxy status` ukáže certifikát `app.test`.
  3. Druhý `setup`: `StartedAt` kontejneru `mup-nginx-proxy` se nezměnil. `proxy start`: změnil se.
  4. Změna `clientUploadLimit` a přidání `nginxLocationConfig` + `deploy`: `default.conf` obsahuje `include /etc/nginx/vhost.d/app.test_location;`, `vhost.d/app.test` obsahuje nový limit a `StartedAt` proxy se nezměnil.
  5. **Nulový výpadek:** `requestLoop` během `deploy` (změna kódu), `reconfig`, `rollback` a `restart` → `failed === 0` pro každý. Pokud brána (b) v úkolu 1 selhala, místo toho se ověří, že výstup obsahuje `Zero-downtime switch not used`.
  6. **Selhání health checku za proxy** (env, která aplikaci shodí): výsledek `reverted`, `requestLoop.failed === 0` a na serveru neexistuje `<name>-next`.
  7. **Vlastní certifikát** (vygenerovaný `openssl` v testu) místo LE a jeho výměna při `deploy`: `openssl s_client` přes port 443 ukáže nový certifikát.
  8. **Docker 29** (spec §5): kroky 1, 2 a 5 (`deploy` se smyčkou požadavků) se opakují na fake serveru s `docker: '29'`. Pokud brána (a) v úkolu 1 skončila STOP a uživatel zvolil jiné řešení, platí jeho rozhodnutí.
  9. **Dvě aplikace** (Review Focus 1): druhá aplikace `app2.test` se nasadí na stejný server. Soubory `vhost.d/app.test*` a certifikáty první aplikace mají stejný hash jako předtím a `curlVia(s1, 'app.test')` stále odpovídá.
- [ ] **Step 2: Napiš `proxy-lb.test.ts`** (2 fake servery, `privateIp` = IP kontejnerů fake serverů, LB, `stickySessions: false`):
  1. `setup` + `deploy`. Upstream na obou proxy je bajtově shodný s tím, co vytvoří `mup proxy setup` se stejným configem (porovnej proti běhu MUP na třetím fake serveru nebo proti renderu orákula).
  2. `requestLoop` během `deploy`: `failed === 0`.
  3. **Přerušený deploy:** během aktivace `two` (po vyřazení) se přeruší SSH spojení. Pak:
     - `status` ukáže `Drained: two`,
     - `setup` ho nevrátí,
     - `restart --servers two` ho vrátí.
  4. `--strategy parallel`: v logu není `drain`.
  5. **Změna `app.env.PORT`** a deploy: `failed === 0`, upstream má nový port.
  6. **Vypnutí a zapnutí `loadBalancing`:** `failed === 0` při obou přechodech.
  7. **Souběžné `deploy --servers s1` a `deploy --servers s2`:** druhý skončí na zámku.
- [ ] **Step 3: Rozšiř `interop.test.ts`:**
  - `mup setup` + `mup deploy` s proxy → comet `deploy` → `mup deploy` → `mup proxy setup` → comet `deploy`. Po každém kroku `curlVia` odpovídá.
  - Soubory `vhost.d`, `upstream` a `proxy-config-container.sh` se shodují s tím, co nechal MUP.
- [ ] **Step 4: Ověř jen syntaxi a typy těchto souborů**, bez spuštění. Run: `npx eslint test/integration test/harness`. Expected: bez chyb.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "test: proxy integration scenarios (LE via Pebble, zero downtime, load balancing, interop)"`

---

### Task 9: Dokumentace

**Files:**
- Modify: `README.md`, `docs/configuration.md`, `docs/commands.md`, `docs/how-it-works.md`, `docs/migrating-from-mup.md`, `docs/troubleshooting.md`

- [ ] **Step 1: Doplň (anglicky):**
  - `proxy` v tabulce podporovaných funkcí,
  - všechny příkazy `proxy *`,
  - rozdíly proti MUP (spec §2 bod 4):
    - promítnutí souborů při deployi,
    - restart proxy jen při změně,
    - nulový výpadek a jeho kompromis (nový kontejner dostává požadavky už během health checku),
    - vyřazování a značka `down`, včetně „`mup proxy setup` značky maže“,
    - zámek u LB a u příkazů proxy,
    - souběh s jinou aplikací na stejné proxy,
  - troubleshooting:
    - vyřazený server (`status`, `restart --servers`),
    - „reverse proxy is not set up“,
    - varování o `shared`,
    - zapnutí a vypnutí LB,
  - výsledek ověření s Dockerem 29 (z ledgeru úkolu 1).

  Odstraň všechny zmínky „planned for phase 2“ u proxy. Žádné konkrétní aplikace, servery ani IP uživatele.
- [ ] **Step 2: Zkontroluj odkazy.** Run: `grep -rn "phase 2" README.md docs/*.md`. Expected: žádná zmínka o proxy.
- [ ] **Step 3: Commit.** `git add -A && git commit -m "docs: reverse proxy"`

---

### Task 10: Finální ověření, review a předání

**Files:**
- Modify: cokoli, co vyleze z kontrol

- [ ] **Step 1: Statické kontroly.** Run: `npm run lint && npm run typecheck && npm run build`. Expected: bez chyb.
- [ ] **Step 2: Unit testy.** Run: `npm test > <workspace>/unit.log 2>&1; tail -20 <workspace>/unit.log`. Expected: všechny PASS.
- [ ] **Step 3: Integrační a e2e testy.** Run: `npm run test:integration > <workspace>/integration.log 2>&1; tail -40 <workspace>/integration.log`. Expected: všechny PASS, včetně úkolu 1 a 8.
- [ ] **Step 4: Oprav nalezené chyby.** Každou opravu ověř testem, který nejdřív selhal. Opakuj kroky 1–3 do zelena. Commit `fix: …`.
- [ ] **Step 5: Finální review celé větve** podle zvoleného postupu (subagent-driven nebo executing-plans). Reviewer dostane spec, tento plán, sekci Review Focus a ledger s `Ruling:` řádky.
- [ ] **Step 6: Předání uživateli.** Shrň:
  - co je hotové,
  - výsledek brány (Docker 29, nulový výpadek),
  - všechny `Ruling:` řádky s cenou, když jsou špatně,
  - odložené drobnosti.

  Test na skutečném serveru se nedělá (spec §2 bod 5). Merge do `main` a push jen na pokyn uživatele.
