# comet-deploy fáze 2, projekt 3: hooks (sekce `hooks`), návrh

- **Stav:** rozhodnutí autora. Uživatel nechal rozsah i pořadí fáze 2 na něm („Nechávám to na tobě, začni tím nejdůležitějším“, 2026-11-12; po mongu „Ano pokračuj“, 2026-11-13).
- **Datum:** 2026-11-13
- **Navazuje na:**
  - Hlavní návrh [`2026-11-07-comet-deploy-design.md`](2026-11-07-comet-deploy-design.md): §7.4 Hooks (názvy, formy, vnoření deploye, API pro `method`) a řádek o `--servers` v §7.2 („respektují ho všechny příkazy včetně status a remote hooks“). Co tam je rozhodnuté, platí dál, pokud tento dokument neříká jinak.
  - Strukturou navazuje na návrh mongo [`2026-11-12-comet-deploy-mongo-design.md`](2026-11-12-comet-deploy-mongo-design.md).
- **Referenční chování MUP:** [`docs/reference/mup-1.5.11.md`](../../reference/mup-1.5.11.md):
  - §1, řádky `--servers`, `--show-hook-names` a `api.getArgs()`;
  - §3.1 (`runCommand`) a §3.2 (které příkazy běží v `post.default.*` hooks);
  - §4 (vnoření deploye);
  - §9.1 (hooks) a §9.3 (PluginAPI).

  Orákulem je zdrojový kód MUP 1.5.11 v devDependencies: `node_modules/mup/lib/plugin-api.js`, `hooks.js`, `plugins/*/index.js` a `plugins/*/commands.js`.

Značení:
- **[uživatel]** = rozhodl uživatel;
- **[hlavní návrh]** = rozhodnuto v hlavním návrhu;
- **[moje volba]** = rozhodnutí autora tohoto návrhu.

---

## 1. Proč

Cíl fáze 2 [uživatel]: comet-deploy má plně nahradit MUP i pro ostatní uživatele. Config se sekcí `hooks` dnes comet-deploy odmítne už před první prací (`CommandRunner.refuseHooks`, `src/core/runner.ts`): „Hook "pre.deploy" is not supported yet“. Kdo hooks používá (testy před deployem, notifikace, migrace, záloha databáze po deployi), musí zůstat u MUP.

Při průzkumu se ukázala chyba, která se týká i configů bez podpory hooks:
- **Klíče příkazů proxy se liší od MUP.** comet-deploy je pojmenoval podle CLI (`proxy.reconfig-shared`, `proxy.logs-le`, `proxy.nginx-config`), MUP podle exportů (`proxy.reconfigShared`, `proxy.leLogs`, `proxy.nginxConfig`, `plugins/proxy/commands.js`). Hook `pre.proxy.reconfigShared` z MUP configu proto comet-deploy neodmítne, ale tiše přeskočí.
- **`status` nevstupuje do klíče `docker.status`**, který MUP v `mup status` spouští.

## 2. Cíle

1. **Config se sekcí `hooks` funguje beze změny** [hlavní návrh §7.4]:
   - všechny formy: `localCommand`, `remoteCommand`, `method(api, nodemiral)` a samotná funkce;
   - stejné názvy, včetně zkratky s jednou tečkou (`pre.deploy` → `pre.default.deploy`);
   - stejné pořadí jako v MUP.
2. **Hooks běží ve stejných logických chvílích jako v MUP.**
   - Každý příkaz vstupuje do stejných klíčů ve stejném pořadí a vnoření jako MUP (§4.3).
   - Klíče proxy dostanou názvy MUP a `status` vstoupí i do `docker.status`.
   - Kde comet-deploy dělá práci jinak (lokální build, aktivace po serverech), §4.3 říká, kam hook přesně padne.
3. **`--show-hook-names` jako MUP:**
   - vypíše `Hook: pre.<klíč>` a `Hook: post.<klíč>` u každého klíče, včetně vnořených;
   - příkaz přitom normálně proběhne.
4. **API pro `method` hooks:** kompatibilní podmnožina `PluginAPI` (§4.6), včetně zdokumentovaného vzoru `api.getSettings(); api.settings.X = …` v `pre.reconfig` [hlavní návrh].
5. **Lepší než MUP, se stejným výsledkem pro fungující config** [moje volba]:
   1. **Úklid po selhání hooku.** Selhaný hook nikdy nenechá zamčené servery, rozjetý registry ani chybějící záznam v historii. Zámky, lease na registry a historie se uklidí stejně jako po každé jiné chybě (§4.2).
   2. **Selhání `remoteCommand` je vidět.** MUP nenulový exit kód ignoruje úplně a chybu spojení jen vypíše. comet-deploy u obojího vypíše varování se serverem a kódem. Příkaz ale pokračuje jako v MUP (§4.5).
   3. **Maskování výstupu.** Výstup hooků (lokální i vzdálený) jde přes maskování tajných hodnot jako zbytek výstupu comet-deploy.
   4. **Varování ve `validate` u neplatných názvů hooků:**
      - název, který neodpovídá žádnému příkazu MUP (překlep, hook nikdy neproběhne);
      - příkaz, který comet-deploy nespouští (§4.8).

## 3. Necíle, anti-cíle, omezení

**Necíle:**
- **Pluginy třetích stran** (`plugins: [...]`) zůstávají nepodporované: dnešní varování zůstane [hlavní návrh]. API je navržené tak, aby šly doplnit později.
- **Části `PluginAPI` postavené na nodemiral a swarmu:**
  - `getSessions`, `getSessionsForServers`, `getManagerSession`, `runTaskList`, `getDockerLogs` (bere nodemiral sessions);
  - `getServerInfo`, `serverInfoStale`, `swarmInfo`, `dockerServiceInfo`, `forwardPort`, `tasks`, `statusHelpers`.

  Volání vyhodí srozumitelnou chybu [hlavní návrh]. Odchylka od hlavního návrhu: `getDockerLogs` tam byl mezi podporovanými, ale bez sessions ho nejde zavolat [moje volba].
- **Hooks u příkazů bez configu** (`init`, `validate`) a u zástupných příkazů fáze 2 (`ssh`, `meteor debug`). `mup validate` by hooks `pre/post.default.validate` spustil. comet-deploy je nespustí a `validate` na ně upozorní (§4.8).
- **Nové formy hooků nebo nové klíče.** Klíče `default.rollback`, `default.history` a podobné existují jen v comet-deploy. `default.rollback` už dnes je a zůstane, další se nepřidávají.

**Anti-cíle (neúspěch, i kdyby to „fungovalo“):**
- **Tiché selhání nebo dvojí spuštění.** Hook, který tiše neproběhne nebo proběhne dvakrát, je chyba. Stejně tak klíč, který MUP spouští a comet-deploy ne, pokud ho §4.3 výslovně nevyjmenuje.
- **Rozbitý stav po selhání hooku:**
  - servery zamčené;
  - aplikace na půl nasazená bez souhrnu;
  - chybějící historie u serveru, který novou verzi už běží.
- **Jakákoli změna pro config bez `hooks`:** jiný výstup, jiné pořadí kroků nebo pomalejší běh. Výjimkou je oprava klíčů proxy, kterou je vidět jen v `--show-hook-names`.
- **Spuštění hooků, když příkaz skončí ještě před první prací** (neplatný config, neznámý server v `--servers`). MUP v tom případě také nic nespustí.

## 4. Chování

### 4.1 Názvy a registrace

- **Zkratka:** název s přesně jednou tečkou dostane `default` doprostřed, jako `registerHook` v MUP (`pre.deploy` → `pre.default.deploy`).
- **Pořadí:** hooky, které se po této normalizaci sejdou pod jedním jménem, běží v pořadí `Object.keys(config.hooks)`.
- **Práce vestavěných pluginů** (meteor.setup, mongo, proxy v `setup`; meteor.deploy v `deploy` a podobně) je v comet-deploy vnořený krok, ne zaregistrovaný hook. Uživatelský `post.default.setup` tak běží až po ní, stejně jako v MUP, kde se vestavěné pluginy registrují před hooky z configu.
- **Kdy se hooky čtou:** jednou při vytvoření kontextu, ze sekce `hooks` normalizovaného configu. `cloneDeep` při normalizaci funkce zachová, ověřit testem.

### 4.2 Kdy hook běží a co znamená selhání

- **`pre.<klíč>` běží těsně před krokem, `post.<klíč>` hned po jeho úspěchu.** Vnořené klíče běží uvnitř vnějšího kroku.
- **Krok selže** (výjimka, přerušení, nebo u kroků s aktivací server, který neskončil `healthy` nebo byl přeskočen):
  - jeho `post` hooky neběží;
  - neběží ani `post` hooky vnějších klíčů;
  - příkaz skončí kódem 1 (130 po přerušení).

  MUP v obou případech skončí `process.exit(1)` a post hooks také nespustí.
- **Selhání hooku je selhání kroku.**
  - Selhaný `pre` hook: krok neproběhne.
  - Selhaný `post` hook: další kroky neproběhnou.
  - Úklid proběhne vždy: zámky (`finally`), lease na lokální registry a dokončení proxy rolloutu. Souhrn se vypíše, pokud už proběhla aktivace.
  - **Historie se zapíše hned po aktivaci, ještě před `post.meteor.start`**, aby selhaný post hook nesmazal záznam o verzi, kterou servery už běží.
  - Pročištění starých verzí po selhaném post hooku neproběhne. Je to jen úklid a další deploy ho dožene.
- **Jeden objekt hooku:** `localCommand` → `method` → `remoteCommand`, jako MUP. Selhání `localCommand` nebo `method` zastaví zbytek objektu i další hooky.
- **Přerušení (Ctrl+C) během hooku:**
  - lokální příkaz dostane SIGINT z terminálu (stejná skupina procesů);
  - `method` a `remoteCommand` se nechají doběhnout;
  - pak comet-deploy zastaví na nejbližším bezpečném místě jako dnes.

### 4.3 Klíče, vnoření a místo hooků v příkazech

Vnoření je stejné jako v MUP (reference §3.2, §4). Odsazení značí vnoření, `→` pořadí sourozenců.

| Příkaz | Klíče |
|---|---|
| `deploy` | `default.deploy` › `meteor.deploy` › (`meteor.push` › `meteor.build` → `meteor.prepareBundle`) → (`default.reconfig` › `meteor.envconfig` → `meteor.start`) |
| `meteor deploy` | totéž bez `default.deploy` |
| `meteor push` | `meteor.push` › `meteor.build` → `meteor.prepareBundle` |
| `meteor build` | `meteor.build` |
| `reconfig` | `default.reconfig` › `meteor.envconfig` → `meteor.start` |
| `meteor envconfig` | `meteor.envconfig` |
| `restart`, `start`, `stop`, `logs` | `default.<cmd>` › `meteor.<cmd>` (varianty `meteor <cmd>` bez `default.`) |
| `status` | `default.status` › `docker.status` → `meteor.status` → (s `mongo`) `mongo.status` → (s `proxy`) `proxy.status` |
| `setup` | `default.setup` › `docker.setup` → `meteor.setup` → (s `mongo`) `mongo.setup` → `mongo.start` → (s `proxy`) `proxy.setup` › `proxy.start` |
| `rollback` | `default.rollback` (jen comet-deploy) |
| `meteor setup`, `meteor destroy` | `meteor.setup`, `meteor.destroy` |
| `docker setup`, `update`, `restart`, `ps`, `status` | `docker.<cmd>` |
| `mongo setup`, `start`, `stop`, `logs`, `shell`, `status` | `mongo.<cmd>` |
| `proxy setup` | `proxy.setup` › `proxy.start` |
| `proxy reconfig-shared` | `proxy.reconfigShared` › `proxy.start` |
| `proxy logs-le`, `nginx-config` | `proxy.leLogs`, `proxy.nginxConfig` (nové názvy klíčů, §1) |
| `proxy start`, `stop`, `logs`, `status` | `proxy.<cmd>` |

**Rozdíly proti MUP, a kam proto hook padne:**

- **Deploy, sourozenci místo vnoření.** Dnešní comet-deploy vnořuje `meteor.envconfig` › `meteor.start` a `meteor.push` balí jen build. Obojí se změní na sourozence a vnoření z tabulky: `post.meteor.envconfig` běží před startem a `post.meteor.push` až po distribuci.
- **Zámek v deployi:**
  - comet-deploy ho bere mezi `post.meteor.build` a `pre.meteor.prepareBundle`;
  - pouští ho po krocích `default.reconfig` a před `post.meteor.deploy`;
  - hooky `pre.meteor.prepareBundle` až `post.default.reconfig` tedy běží se zámkem, `post.meteor.deploy` a `post.default.deploy` až po odemčení a po souhrnu.
- **`meteor.prepareBundle` je u comet-deploy distribuce image na servery.** V MUP je to stavba image na serveru, ale logicky je to stejné místo: „image je na serverech, aplikace ještě běží starou verzi“.
- **`meteor.envconfig` v deployi a v `reconfig`.** comet-deploy zapisuje `env.list` a `start.sh` až v aktivaci každého serveru, aby kanárek a revert fungovaly po serverech. Hooky `pre.meteor.envconfig` a `post.meteor.envconfig` proto běží těsně po sobě, před aktivací. Hook, který v `post.meteor.envconfig` čte `env.list` na serveru, uvidí ještě starý [moje volba]. Samostatný `meteor envconfig` soubory zapisuje uvnitř kroku jako MUP.
- **`meteor.start` v deployi je celá aktivace podle strategie:** start, health check a revert na všech serverech. `post.meteor.start` běží jednou, po všech serverech.
- **`status`:** `docker.status` je prázdný krok. Docker je ve stejné tabulce jako aplikace, takže krok jen drží místo pro hooky.

### 4.4 `localCommand`

- **Spuštění:** přes `/bin/sh -c` jako `execSync` v MUP, s `cwd` = adresář configu (`basePath`) a `env` = prostředí procesu. stdin je zděděný, takže skript se může ptát. stdout a stderr jdou po řádcích přes reporter: s maskováním, a když není TTY, tak bez barev.
- **Řádek před spuštěním:** `> Running hook pre.default.deploy "npm test"`. MUP u pre hooků vynechává `pre.` (`> Running hook default.deploy …`), comet-deploy píše vždy celé jméno [moje volba].
- **Selhání:** nenulový kód nebo signál → `Hook "pre.default.deploy" failed: "npm test" exited with code 1.` (MUP: „Hook failed.“, exit 1).

### 4.5 `remoteCommand`

- **Kde běží:** na všech serverech ze sekce `servers` (ne jen na serverech aplikace, jako MUP), zúžených podle `--servers` [hlavní návrh §7.2]. Běží paralelně přes SSH pool comet-deploy, bez sudo, v přihlašovacím shellu uživatele, jako `runSSHCommand` v MUP.
- **Řádek před spuštěním:** `> Running hook post.default.deploy remote command "…"`.
- **Výstup:** u každého serveru po jeho doběhnutí blok `=> output from <host>` a pak výstup (stdout a stderr dohromady, maskovaný).
- **Nenulový kód nebo chyba spojení:** varování `Hook "post.default.deploy": the remote command exited with code 3 on server "one".` (resp. `could not run on server "one": <chyba>`) a příkaz pokračuje jako v MUP [moje volba: kompatibilita, MUP takový hook nikdy nepovažuje za selhání]. Dokumentace řekne, že na kontrolu, která má deploy zastavit, patří `localCommand` (např. `ssh …`) nebo `method` s `api.runSSHCommand` a kontrolou `code`.

### 4.6 `method` a objekt `api`

- **Volání:** `await method(api, nodemiral)`. Výjimka nebo odmítnutý Promise → `Hook "<jméno>" failed: <zpráva>`; stack se vypíše s `--verbose`.
- **Jeden `api` na celé spuštění příkazu**, sdílený všemi hooky, takže `api.settings.X = …` vydrží do dalších kroků (MUP: jedna instance `PluginAPI`).
- **`nodemiral`** je objekt, jehož každá vlastnost vyhodí `nodemiral is not available in comet-deploy. Use api.runSSHCommand(server, command) instead.`

Podporované členy:

| Člen | Chování |
|---|---|
| `getArgs()` | `argv._` plus volby, které uživatel napsal, bez `settings, config, verbose, show-hook-names, help, servers`, jako MUP. |
| `getBasePath()`, `getVerbose()`, `getOptions()` | Adresář configu, `--verbose`, argv příkazu. |
| `getConfig()` | **Živý** normalizovaný config kontextu. Změny (např. `api.getConfig().app.env.X = 'y'`) platí pro kroky, které config čtou později. |
| `setConfig(c)` | Nahradí config kontextu, jako MUP bez validace. Platí pro kroky, které začnou později. |
| `validateConfig()` | Seznam problémů jako řetězce `"<cesta> <zpráva>"` z validace comet-deploy. |
| `scrubConfig()` | Kopie configu se skrytými tajnými hodnotami, stejně jako `validate --scrub`. |
| `getSettings()` | Stejný objekt jako `ctx.getSettings()`. |
| `settings` | Čte i zapisuje. Přiřazení nahradí nastavení pro další kroky. Deploy a `reconfig` čtou nastavení až při aktivaci, ne před buildem, aby změna z `pre.reconfig` platila. |
| `getSettingsFromPath(p)` | Načte JSON stejnými pravidly jako `--settings`. |
| `runCommand(key)` | Spustí krok comet-deploy pro daný klíč i s jeho hooky, vnořeně jako MUP. |
| `runSSHCommand(server, cmd)` | `{ code, output, host }`. `server` je objekt ze `config.servers`: když je to jeden z nich (podle identity nebo `host`), použije pool, jinak otevře vlastní spojení se stejnými volbami. |
| `resolvePath(...p)` | `path.resolve` s rozvinutím `~`. |
| `hasMeteorPackage(name)` | Hledá `name@` v `.meteor/versions` aplikace. Cestu bere z `app.path`, ne z `meteor.path` jako MUP, kde je to chyba. |
| `swarmEnabled()` | `false`. |
| `commandHistory` | Živé pole `{ name }` v pořadí, v jakém kroky začaly. |
| `base`, `args`, `config`, `configPath`, `settingsPath`, `verbose`, `program` | Vlastnosti se stejným obsahem jako v MUP. `config` je getter na živý config. |

**`runCommand(key)` podrobněji:**
- Zná každý klíč z §4.3, který má v comet-deploy samostatný krok.
- `meteor.prepareBundle` (distribuce bez buildu) a `docker.destroyCluster` vyhodí `api.runCommand("<key>") is not supported by comet-deploy.`
- Neznámý klíč vyhodí text MUP `Unknown command name: <key>`.
- Volání příkazu, který bere zámek (deploy, reconfig, restart, rollback, start, stop, setup, meteor destroy, mongo/proxy příkazy se zámkem), z hooku, který běží se zámkem téhož příkazu, vyhodí chybu ještě před zamykáním. Chyba řekne, že hook běží se zámkem, a doporučí `post.default.deploy`. Jinak by druhý zámek čekal na první, nebo by selhal s matoucím „locked by you“ [moje volba].

Nepodporované členy (§3) vyhodí `api.<name>() is not supported by comet-deploy (it needs MUP's nodemiral sessions). Use api.runSSHCommand(server, command) or a remoteCommand hook.`

### 4.7 `--show-hook-names`

- U každého klíče vypíše `Hook: pre.<klíč>` před krokem a `Hook: post.<klíč>` po jeho úspěchu, vždy celé jméno, i u vnořených klíčů.
- Řádky mají barvu varování jako žlutá v MUP, bez TTY jsou bez barvy.
- Příkaz i hooky normálně proběhnou.
- Dnešní text „Hooks are not supported yet …“ a konec bez spuštění odpadnou.

### 4.8 Validace

- **Tvar podle schématu MUP:** každá hodnota je objekt jen s `localCommand` (řetězec), `remoteCommand` (řetězec) a `method` (funkce), nebo samotná funkce.
  - Chybný tvar je **chyba**: hook by nešel spustit.
  - Neznámá vlastnost uvnitř objektu je varování jako jinde (`is an unknown property`).
- **Varování** [moje volba]:
  - `hooks."pre.deplyo" does not match a command, so it never runs`: klíč není mezi příkazy MUP ani comet-deploy.
  - `hooks."pre.default.ssh" belongs to a command comet-deploy does not run, so it never runs`: klíče `default.init`, `default.validate`, `default.ssh`, `meteor.debug`, `docker.destroyCluster`, `proxy.envconfig`.
  - Název bez `pre.` nebo `post.` na začátku: `hooks."deploy" must start with "pre." or "post."`.
- Seznam klíčů MUP je pevný seznam v kódu, opsaný z `plugins/*/commands.js` MUP 1.5.11. Test ho porovná s MUP v devDependencies.

### 4.9 Kód

- **`src/core/runner.ts`:**
  - `CommandRunner` zůstane místem, kde se klíče spouštějí: `run(key, fn)` = pre hooky, `fn`, post hooky;
  - přibude `enter(key)` / `leave(key)` pro kroky, jejichž rozsah není lexikální (deploy: `meteor.push` začíná buildem a končí distribucí, mezi nimi je zámek);
  - `refuseHooks` zmizí;
  - výsledek kroku s aktivací se počítá jako selhání, když není `ok`.
- **`src/hooks/`:**
  - `registry.ts`: normalizace jmen, seznam klíčů MUP, validace;
  - `run.ts`: `localCommand`, `remoteCommand`, `method`;
  - `api.ts`: `PluginAPI`;
  - `commands.ts`: klíč → krok, pro `runCommand`.
- Kontext dostane měnitelný config a nastavení (`setConfig`, `setSettings`).

## 5. Interop s MUP

- **Na serveru se nic nemění.** Hooky nic nezapisují a jejich názvy jsou stejné, takže config s hooks jde střídavě nasazovat MUPem a comet-deploy.
- **Integrační test porovná pořadí:**
  - na jednom configu porovná řádky `Hook:` z `mup <cmd> --show-hook-names` a `comet-deploy <cmd> --show-hook-names`;
  - příkazy `setup`, `deploy`, `reconfig`, `restart`, `stop`, `start`, `status`;
  - config má sekce `mongo` a `proxy`.

  Rozdíly povolené v §4.3 jsou v testu vyjmenované.

## 6. Testy

**Unit:**
- runner: pořadí pre → krok → post, vnoření, `enter`/`leave`, žádné post hooky po selhání, post hooky vnějších klíčů po selhání vnitřního;
- jména a zkratky, pořadí registrace, pořadí uvnitř objektu;
- `localCommand`: výstup, maskování, `cwd`, selhání s kódem;
- `remoteCommand`: servery a `--servers`, varování u kódu a chyby spojení;
- `method`: chyba, každý člen API z tabulky, nepodporované členy, `nodemiral`;
- `runCommand`: klíč → krok, neznámý klíč, nepodporovaný klíč, zámek;
- deploy s hookem, který selže v každé fázi: zámky uvolněné, registry lease vrácený, historie zapsaná po aktivaci;
- `api.settings` z `pre.reconfig` se dostane do `METEOR_SETTINGS`;
- `--show-hook-names`;
- validace: chyby i varování;
- seznam klíčů proti `node_modules/mup`.

**Integrace (falešné servery):**
- `deploy` s hooky všech tří forem na více klíčích zapíše do souboru na serveru i lokálně očekávané pořadí;
- selhaný `pre.meteor.start` nechá aplikaci na staré verzi a servery odemčené;
- interop podle §5.

## 7. Dokumentace

- **`configuration.md`:** sekce Hooks přepsaná. Tabulka klíčů, vnoření a rozdílů z §4.3, formy, `api`, `--show-hook-names`, chování při selhání, `remoteCommand` a kontroly. Odpadne řádek z „Planned for phase 2“.
- **`commands.md`:** `--show-hook-names`.
- **`migrating-from-mup.md`:** hooks a tabulka rozdílů.
- **`troubleshooting.md`:**
  - selhaný hook;
  - hook, který neproběhne (varování ve `validate`);
  - `runCommand` se zámkem.
- **`how-it-works.md`:** místo hooků v pipeline.
- **README:** stav, roadmapa.

## 8. Co je na implementátorovi

- Přesné texty výstupu, pokud je tento dokument nedává doslova.
- Podoba testovacího configu pro integrační test, pokud pokrývá §5 a §6.
- Rozdělení do souborů v `src/hooks/`, pokud zůstane odpovědnost z §4.9.
