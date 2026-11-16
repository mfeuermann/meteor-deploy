# comet-deploy fáze 2, projekt 7: `ssh`, `meteor debug`, plný `status` a `cache prune`

Stav: návrh, 2026-11-16. Navazuje na hlavní návrh `2026-11-07-comet-deploy-design.md` (§ příkazy: „`meteor debug`, `ssh`, `status`, `init`: jako MUP“) a na roadmapu v README (poslední položka fáze 2).

Uživatel rozhodnutí o návrhu nechal na mně, stejně jako u projektů proxy, mongo, hooks, stream, registry a bundle mode. Moje volby jsou označené [moje volba].

Builder check (2026-11-16) otevřel pět otázek, všechny jsem rozhodl sám:
1. `cache prune` smaže celý `buildLocation` jen s `cleanBuildLocation: true` (výchozí dočasná cesta), jinak jen soubory, které tam píše comet-deploy (§4.5);
2. `cache prune` se týká jen záznamů a tagů repozitáře `mup-<app.name>` z tohoto configu, protože dva configy (staging, production) se stejnou `app.path` sdílí jeden `state.json` (§4.5);
3. `cache prune` maže i tagy, které v `state.json` nejsou, pokud jsou podle verze starší než nejnovější ponechaný záznam (§4.5);
4. `meteor debug` s kontejnerem v síti `host` nepoužije naslouchající socat (§4.3);
5. první slovo za `ssh` je server jen tehdy, když je to jméno serveru z configu (§4.1).

Čtyři příkazy jsou na sobě nezávislé, ale každý je malý a sdílejí stejné základy (výběr serveru, interaktivní SSH, výstup). Proto jeden návrh a jeden plán, s úkolem na každý příkaz [moje volba].

## 1. Proč

- **`ssh` a `meteor debug`** dnes jen vypíšou `"ssh" is not supported yet: it is planned for phase 2 of comet-deploy.` a skončí s kódem 1 (`src/cli/commands/phase2.ts`). Uživatel MUP je zná a čeká je.
- **`status`** dnes ukáže jeden řádek na server (Docker, kontejner, verze, HTTP, zámek), pak blok MongoDB a proxy. MUP bez `--overview` ukáže plný report: operační systém serverů, verze Dockeru, stav kontejneru, počet restartů, porty, ENV a dostupnost aplikace. Migrating guide to slibuje jako fázi 2.
- **Lokální stav roste.** Lokální image `mup-<app>:<verze>` (posledních 20 buildů na aplikaci), build directory (`buildOptions.buildLocation`, stovky MB) a hlavně volume lokální registry `comet-deploy-registry-data`, které comet-deploy nikdy nečistí. Dnes to jde uklidit jen ručně podle troubleshootingu.

MUP dělá `meteor debug` nebezpečně: socat kontejner `meteor-debug-2` publikuje port 9227 inspektoru Node na **všech rozhraních serveru** (`-p 9227:9227`), lokálně poslouchá na `0.0.0.0:9229` a pomocné kontejnery nikdy neuklidí. Inspektor dovoluje spustit libovolný kód v aplikaci. MUP `status` vypisuje ENV **i s hodnotami** (`MONGO_URL` s heslem, `METEOR_SETTINGS`). Tyhle dvě věci comet-deploy nepřebírá.

## 2. Cíle

1. `comet-deploy ssh [server] [command..]` otevře shell na serveru, nebo na něm spustí příkaz, se stejnými SSH údaji jako ostatní příkazy.
2. `comet-deploy meteor debug [server]` zpřístupní inspektor Node běžící aplikace na `127.0.0.1:<port>` lokálního počítače, aby se dalo ladit z Chrome DevTools jako s MUP. Na serveru se nic nepublikuje a po ukončení příkazu se pomocný kontejner smaže.
3. `comet-deploy status` bez `--overview` ukáže plný report jako MUP, bez hodnot ENV. `status --overview` ukáže přesně to, co `status` ukazuje dnes.
4. `comet-deploy cache prune` uklidí lokální stav aplikace z configu: staré lokální image, build directory a záznamy build cache, volitelně i lokální registry.
5. Dokumentace (commands, migrating-from-mup, troubleshooting, README roadmap) odpovídá; fáze 2 je v README hotová.

## 3. Necíle, anti-cíle, omezení

- **Necíle:** `status --json`; `ssh` na více serverů najednou; ladění jiného procesu než aplikace; čištění BuildKit cache (`docker builder prune` je globální pro celý stroj a stojí další `npm install`, troubleshooting na něj odkazuje dál); čištění na serverech (to dělá deploy).
- **Anti-cíle:**
  - Inspektor dosažitelný odjinud než z lokálního `127.0.0.1` uživatele, který se přihlásil přes SSH. Na serveru žádný publikovaný port.
  - Hodnota proměnné prostředí ve výstupu `status`.
  - `cache prune`, který smaže image, na kterém závisí další deploy beze změn (`No changes since …`), pokud o to uživatel výslovně nepožádá (`--all`).
  - Příkazy, které mění stav serveru (`ssh` a `debug` neberou zámek a nic nezapisují do historie).
- **Omezení:** `ssh2` (žádný systémový `ssh`), existující `SshConnection.interactive` a `runInteractive` (`src/ssh/interactive.ts`), jedno SSH spojení na server, výstup přes reporter, Node ≥ 20, macOS a Linux.

## 4. Chování

### 4.1 Výběr serveru (`ssh`, `meteor debug`)

- Jako MUP: argument `server` je jméno ze `servers` v configu (u `meteor debug` jméno z `app.servers`). Kandidáti jsou servery, které zbývají po `--servers`.
- **První slovo je jméno serveru** (kandidáta): použije se ten server; u `ssh` zbytek slov je příkaz.
- **Bez slov:** když zbývá právě jeden kandidát, vezme se ten. Jinak chyba (exit 1):
  ```
  Choose a server: comet-deploy ssh <server>. Servers: one, two
  ```
  (u debug `comet-deploy meteor debug <server>` a jen app servery).
- **První slovo není jméno serveru** [moje volba]:
  - u `ssh` se zbývajícím jediným kandidátem patří slovo k příkazu: `comet-deploy ssh uptime` i `comet-deploy ssh -- uptime` spustí `uptime` na jediném serveru (MUP by slovo ignoroval a otevřel shell; překlep ve jméně serveru tu skončí jako „command not found“, nic nezmění);
  - jinak (víc kandidátů, nebo `meteor debug`) chyba `Unknown server "x". Servers: one, two`.
- Argumenty se čtou z pozičních slov yargs i ze slov za `--`, ve stejném pořadí, jak je uživatel napsal.
- Obě funkce sdílí jeden helper.

### 4.2 `ssh [server] [command..]`

- **Bez příkazu:** interaktivní přihlašovací shell přes `client.shell()` z `ssh2`, jako MUP. V terminálu s pseudo-terminálem velikosti okna, který sleduje změny velikosti, a lokální terminál je v raw módu (stejně jako `mongo shell` přes `runInteractive`). Bez terminálu (vstup z roury) shell bez pseudo-terminálu, který čte vstup [moje volba]. Exit kód příkazu = exit kód shellu.
- **S příkazem:** `comet-deploy ssh one -- docker ps` spustí `docker ps` jako `ssh host docker ps`: slova příkazu se spojí mezerou a pošlou serveru, kde je vyhodnotí shell uživatele (stejně jako OpenSSH). V terminálu dostane pseudo-terminál (aby fungovalo `docker exec -it`), jinak čisté roury [moje volba]. Exit kód příkazu se předá dál.
- Pod klíčem MUP `default.ssh` v runneru, takže hooky `pre./post.default.ssh` běží jako v MUP [moje volba].
- Žádný zámek, žádná historie. Nepřipojitelný server je chyba s exit 1.

### 4.3 `meteor debug [server] [--port <n>]`

Postup:

1. **Server** podle §4.1, jen app servery.
2. **Kontejner aplikace musí běžet**, jinak chyba `The app container "<name>" does not run on "<server>".` s hintem `Start it with "comet-deploy start".`
3. **Zapnutí inspektoru:** `sudo docker exec <app> sh -c 'kill -s USR1 $(pidof -s node)'` (MUP totéž bez `sudo`). Node pak poslouchá na `127.0.0.1:9229` uvnitř kontejneru. Když příkaz selže (v image chybí `pidof`, žádný proces `node`), chyba s výstupem příkazu.
4. **Pomocný kontejner** v síťovém jmenném prostoru aplikace, smazaný po ukončení:
   ```
   sudo docker rm -f <app>-debug 2>/dev/null
   sudo docker run -d --rm --name <app>-debug --network container:<app> alpine/socat:1.8.1.1 \
     TCP-LISTEN:9228,fork,reuseaddr,range=<gateway>/32 TCP:127.0.0.1:9229
   ```
   - `<gateway>` je gateway první sítě kontejneru aplikace a `<ip>` jeho IP v ní: `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.Gateway}}{{"\n"}}{{end}}' <app>`, první řádek (jako MUP `head -n 1`). Spojení ze serveru (sshd) na IP kontejneru přichází z adresy gateway, takže `range` pustí jen server samotný, ne ostatní kontejnery na stejné síti [moje volba].
   - Image `alpine/socat` je připnutý na `1.8.1.1` (amd64 i arm64, vydaný v červnu 2026) [moje volba; MUP bere `alpine/socat` bez verze]. Pull jako u ostatních pomocných image (chyba pullu = chyba příkazu s hintem na rate limit).
   - Port 9228 uvnitř jmenného prostoru aplikace je pevný; aplikace na něm poslouchat nemá (troubleshooting).
5. **Lokální listener** na `127.0.0.1:<port>`, výchozí `9229` (MUP: `0.0.0.0:9229`). Obsazený port je chyba `Port 9229 is in use on this computer.` s hintem `Use --port <n>, and add localhost:<n> in chrome://inspect → Configure.`
6. **Každé lokální spojení** jde přes SSH `forwardOut` na `<ip>:9228`. Server bez TCP forwardingu (`AllowTcpForwarding no`, sshd odpoví „administratively prohibited“) se přepne na zálohu: každé spojení dostane kanál `sudo docker exec -i <app>-debug socat STDIO TCP:127.0.0.1:9229` a data jdou přes jeho stdin/stdout. Přepnutí se oznámí jednou: `SSH TCP forwarding is off on "<server>": the debugger connection goes through docker exec, which is slower to connect.` [moje volba: debug funguje na stejných serverech jako `transfer: 'stream'`].
7. **Výpis po připojení**, převzatý z MUP a upravený (port, žádné „0.0.0.0“):
   ```
   Debugger of "<app>" on "<server>": ws://127.0.0.1:9229

   To debug:
   1. Open chrome://inspect in Chrome
   2. Select "Open dedicated DevTools for Node"
   3. Wait a minute while it connects and loads the app. The app's files appear in the Sources tab.

   Do not use breakpoints on a production server: they pause the app, which then answers no methods or subscriptions. Use logpoints instead.
   The debugger stays enabled in the app until it restarts; it is reachable only while this command runs. Press Ctrl+C to stop.
   ```
   První spojení vypíše jednou `Debugger connected.` (MUP „Detected by debugger“).
8. **Konec:** Ctrl+C (nebo SIGTERM) zavře listener a spojení, smaže `<app>-debug` (`sudo docker rm -f`, chyba jen varuje) a skončí s kódem 0. Smazání proběhne i po chybě v krocích 5–7.
9. **Kontejner v síti `host`** (`docker.args` s `--network=host`; `status.sh` to dnes pozná podle `[host` v `.NetworkSettings.Networks`) [moje volba]: inspektor pak poslouchá na `127.0.0.1:9229` samotného serveru. Pomocný kontejner nic neposlouchá: `sudo docker run -d --rm --name <app>-debug --network host --entrypoint sleep alpine/socat:1.8.1.1 infinity` (slouží jen záloze). `forwardOut` míří na `127.0.0.1:9229`, záloha běží jako v kroku 6 (`docker exec -i <app>-debug socat STDIO TCP:127.0.0.1:9229`). Na serveru se tedy nic nového neotevře ani tady; inspektor na `127.0.0.1` serveru je dosažitelný pro lokální uživatele serveru (tak ho Node otevírá sám, troubleshooting to zmíní). Krok 4 s `range` se v tomto případě nepoužije.
10. **Kontejner aplikace zmizel** (deploy, restart, stop během ladění): pomocný kontejner s ním skončí (`--rm`, sdílený jmenný prostor). Když spojení selže a `<app>-debug` už neběží, příkaz skončí s chybou `The app container on "<server>" was replaced or stopped; run "comet-deploy meteor debug" again.` [moje volba].
11. Pod klíčem MUP `meteor.debug` v runneru (hooky). Žádný zámek: debug nemění, co na serveru běží, kromě zapnutého inspektoru, stejně jako MUP.

### 4.4 `status` a `status --overview`

- **`status --overview`:** přesně dnešní výstup `status` (tabulka `SERVER DOCKER APP VERSION HTTP LOCK`, jednořádkový blok MongoDB, blok proxy).
- **`status` (bez `--overview`):** tabulka jako dnes, pak plný report, pak plné bloky MongoDB a proxy jako dnes.
- **Plný report** má jednu sekci na app server, data z jednoho SSH round tripu na server (rozšířený `templates/comet/status.sh` nebo druhý skript; rozhodne implementátor):
  ```
  == one (203.0.113.10)
  Server:     Ubuntu 24.04.1 LTS, x86_64, Docker 27.5.1, 18.2 GB free in /var/lib/docker
  Container:  running since 2026-11-16 08:12 (3 h 4 min), restarted 0 times
  Version:    20261116-081100-1a2b3c4 (:previous 20261115-170200-9f8e7d6)
  Ports:      127.0.0.1:3000 -> 3000/tcp
  Env:        14 variables: MONGO_URL, METEOR_SETTINGS, PORT, ROOT_URL, …
  HTTP:       200 on the server (http://127.0.0.1:3000/), 200 from this computer (https://app.example.com/)
  ```
  - **Server:** `PRETTY_NAME` z `/etc/os-release`, `uname -m`, verze Dockeru, volné místo v adresáři dat Dockeru (`docker info -f '{{.DockerRootDir}}'`, `df -Pk`).
  - **Container:** stav (`running`, `restarting`, `stopped`, `missing`), od kdy běží (`.State.StartedAt`, lokální čas a doba běhu), počet restartů. Varování (žlutě) při restartech > 0 nebo stavu `restarting` [moje volba podle MUP].
  - **Version:** verze, na kterou ukazuje `:latest`, a verze `:previous`; `-` pro verzi, která není verzí comet-deploy (po `mup deploy`): `not a comet-deploy version (MUP deployed it)`.
  - **Ports:** publikované porty kontejneru (`HostIp:HostPort -> port/proto`), jinak `none published (behind the proxy)` nebo `none published`.
  - **Env:** počet proměnných a jejich **jména** v pořadí z kontejneru, nikdy hodnoty [moje volba proti MUP].
  - **HTTP:** stav health check cesty ze serveru (to, co dnes měří sloupec HTTP) a z tohoto počítače: GET na efektivní `ROOT_URL` serveru plus `cometDeploy.healthCheck.path`, timeout 5 s, výsledek je HTTP stav nebo krátká chyba (`timeout`, `connection refused`, `DNS lookup failed`, `TLS error`). Stejná URL pro víc serverů se měří jednou [moje volba; MUP měří `host:PORT` nebo `VIRTUAL_HOST`].
  - Nepřipojitelný server: sekce s jedním řádkem `unreachable: <důvod>` (dnes varování a řádek tabulky; zůstane i to).
- **Rozdílné verze Dockeru** mezi servery: varování pod tabulkou `The servers run different Docker versions: 27.5.1 (one), 26.1.4 (two).` (MUP).
- Exit kód `status` je 0, i když server není dosažitelný (jako dnes); chyba configu nebo SSH údajů skončí jako dnes.

### 4.5 `cache prune [--all] [--registry] [--dry-run]`

Příkaz jen pro comet-deploy, ve skupině `cache` (`comet-deploy cache` bez podpříkazu vypíše nápovědu) [moje volba: MUP nic takového nemá, `prune` samotné by se pletlo s čištěním starých verzí na serverech při deployi]. Načte config (kvůli jménu aplikace, cestě k aplikaci a `buildLocation`), na servery se nepřipojuje.

**Rozsah** [moje volba]: `state.json` je klíčovaný cestou k aplikaci, ne configem, takže `.deploy/staging` a `.deploy/production` se stejnou `app.path` sdílí jeden soubor. Prune proto bere jen záznamy, jejichž `localTag` patří repozitáři `mup-<app.name>` tohoto configu (`localImageRepo`), a jen tagy toho repozitáře. Záznamy a image druhého configu zůstanou beze změny.

Co dělá pro aplikaci z configu:

1. **Lokální image verzí ze záznamů:** smaže tagy záznamů svého repozitáře kromě **nejnovějšího záznamu pro každou platformu**, takže další deploy beze změn i `--cached-build` dál fungují. Image se maže `docker rmi <tag>` bez `--force`; image, který Docker odmítne (používá ho kontejner), zůstane a vypíše se varování. Smazané záznamy se z `state.json` odstraní (atomický zápis jako `BuildCache.save`), záznamy jiných repozitářů zůstanou.
2. **Tagy mimo `state.json`** (pád mezi buildem a uložením záznamu, neúspěšné `rmi`, zbytky `127.0.0.1:<port>/mup-<app>:<verze>` z přerušeného pushe, starší `state.json`): prune vypíše `docker images` repozitáře `mup-<app.name>` i `<cokoli>/mup-<app.name>` a smaže tag, jehož jméno je verze comet-deploy (`YYYYMMDD-HHMMSS…`, i s příponou `-amd64`/`-arm64`) **starší** než nejstarší ze záznamů, které zůstávají. Deploy, který právě staví, má novější verzi, takže jeho image zůstane. Tagy, které nejsou verzí (`latest`, `build`, cizí jména), prune nechá a jen je vypíše ve verbose.
3. **Build directory:** s `buildOptions.cleanBuildLocation: true` (vynucené pro výchozí dočasnou cestu, `src/config/normalize.ts`) smaže celý `buildLocation` a jeho varianty `-amd64` / `-arm64`; ty comet-deploy maže před každým buildem tak jako tak. Bez něj (vlastní cesta uživatele) smaže jen to, co tam comet-deploy píše: `bundle/`, `bundle.tar.gz` a `.dockerignore` kontextu [moje volba: v cizím adresáři nemazat cizí soubory]. Záznamy cache build directory nepotřebují (`bundleDir` se po buildu nečte).
4. **`--all`:** smaže i nejnovější image každé platformy, všechny tagy verzí repozitáře podle bodu 2 bez ohledu na stáří a záznamy svého repozitáře ze `state.json` (soubor zmizí, když v něm nic nezbude). Další deploy postaví vše znovu (`npm install` z BuildKit cache se ale použije znovu). Souběžný deploy tu o svůj image přijít může; dokumentace to řekne.
5. **`--registry`:** smaže lokální registry (`comet-deploy-registry`) i jeho volume (`comet-deploy-registry-data`), ale jen pod zámkem leasů registry (`withLeaseLock` v `src/transfer/local-registry.ts`) a jen když žádný běžící deploy nedrží lease. Jinak chyba `A deploy is using the local registry (pid 1234); run "cache prune --registry" when it has finished.` Registry je společná pro všechny aplikace na stroji; další deploy každé z nich jednou nahraje celý image do lokální registry (lokálně, na servery se posílají dál jen chybějící vrstvy).
6. **`--dry-run`:** vypíše, co by se smazalo, a nic nesmaže.

Výstup: co se smazalo (počet image s jejich tagy ve verbose, build directory s velikostí, registry s velikostí volume), co zůstalo (nejnovější image) a na konci hint, když registry nebylo součástí: `The local registry holds 12.4 GB; "comet-deploy cache prune --registry" removes it.` Velikost volume přes `docker system df -v` nebo `docker volume inspect` + `du` (rozhodne implementátor; neznámá velikost = vynechá se).

Souběh s deployem stejné aplikace [moje volba]: nejnovější image i novější tagy mimo záznamy zůstávají, takže deploy, který právě staví, o svůj image nepřijde. Deploy, který zrovna nasazuje starší image z cache (cache hit), o něj přijít může; dokumentace říká „nespouštějte `cache prune` během deploye“. Zamykat build kvůli tomu nebudu.

### 4.6 Placeholdery

`src/cli/commands/phase2.ts` zmizí i s testy. Nápověda: `ssh` je v `--help` (`Open a shell on a server, or run a command there`), `debug` v `meteor --help`, `cache` v `--help`.

## 5. Kód

- **`src/ssh/connection.ts`:** `shell(o: InteractiveOptions): Promise<number>` (přes `client.shell`), `forwardOut(host, port): Promise<Duplex>` (přes `client.forwardOut`, chyba „administratively prohibited“ rozpoznatelná, např. `ForwardingRefusedError` nebo `code`). `runInteractive` dostane variantu pro shell bez příkazu.
- **`src/cli/commands/ssh.ts`**, **`src/cli/commands/debug.ts`** (logika ladění v `src/remote/debug.ts` nebo podobně, testovatelná bez CLI), **`src/cli/commands/cache.ts`** (logika v `src/build/prune.ts`), **`src/cli/commands/status.ts`** rozšířený o plný report (formátování v samostatné funkci, testované na textech).
- **Helper výběru serveru** (§4.1) sdílený `ssh` a `debug`.
- **`BuildCache`** dostane metody pro prune (seznam záznamů, odebrání záznamů), aby `state.json` zapisovala jen jedna třída.
- **Lokální registry:** funkce `removeLocalRegistry` v `src/transfer/local-registry.ts`, pod `withLeaseLock`.

## 6. Testy

- **Unit:**
  - výběr serveru (jeden server, `--servers`, neznámé jméno, víc serverů bez jména);
  - `ssh`: příkaz se spojí a pošle, exit kód se předá, raw mód se vrátí i po chybě, shell bez příkazu volá `shell()`;
  - debug: skripty a jejich proměnné (inspektor, pomocný kontejner, `range` s gateway), port obsazený, přepnutí na zálohu při „administratively prohibited“, úklid pomocného kontejneru po Ctrl+C i po chybě, zmizelý kontejner;
  - status: parser rozšířeného výstupu skriptu, formátování plného reportu, ENV jen jména (test, že žádná hodnota z kontejneru se ve výstupu neobjeví), různé verze Dockeru, `--overview` = dnešní výstup beze změny;
  - prune: co se smaže a co zůstane (nejnovější na platformu, `--all`, `--dry-run`), `state.json` po prune, záznamy druhého configu se stejnou `app.path` zůstanou, tagy mimo záznamy (starší smazat, novější a ne-verze nechat), build directory s `cleanBuildLocation` i bez něj (cizí soubor zůstane), odmítnuté `rmi`, `--registry` s živým a mrtvým leasem;
  - výběr serveru: první slovo jako server, jako příkaz při jediném kandidátovi, slova za `--`.
  - debug v síti `host`: žádný naslouchající socat, `forwardOut` na `127.0.0.1:9229`.
- **Integrace (fake server):**
  - `ssh one -- echo hi` vypíše `hi` a exit kód `ssh one -- false` je 1;
  - `meteor debug` proti nasazené ukázkové aplikaci: HTTP `GET http://127.0.0.1:<port>/json/version` přes lokální listener vrátí JSON s `"Browser": "node.js/…"`, po ukončení na serveru `<app>-debug` neexistuje a žádný port není publikovaný; totéž na serveru s vypnutým TCP forwardingem (záloha přes `docker exec`);
  - `status` proti nasazené aplikaci: sekce serveru obsahuje verzi, porty a jména ENV a žádnou hodnotu z `env` configu;
  - `cache prune` proti lokálnímu Dockeru: s několika tagy `mup-<app>:*` a `state.json` zůstane jen nejnovější; `--registry` smaže kontejner i volume registry.
- **Interop s MUP:** není potřeba, příkazy MUP nemění stav, se kterým MUP pracuje (`debug` přidá jen dočasný kontejner `<app>-debug`, jiné jméno než `meteor-debug` z MUP).

## 7. Dokumentace

- **commands.md:** sekce `ssh`, `meteor debug`, `cache prune`; `status` s plným reportem a `--overview`; zmizí tabulka „not supported yet“.
- **migrating-from-mup.md:** řádky příkazů (`mup ssh`, `mup meteor debug`, `mup status`) bez „phase 2“; rozdíly: debug jen na `127.0.0.1`, bez publikovaného portu na serveru, ENV bez hodnot.
- **troubleshooting.md:** obsazený lokální port, TCP forwarding vypnutý (záloha), `pidof` chybí v image, kontejner aplikace zmizel, port 9228 v aplikaci; `cache prune` místo ručního úklidu (ruční postup zůstane pro BuildKit cache).
- **README:** roadmapa „Phase 2: done.“, FAQ/status bez zmínek o fázi 2 u těchto příkazů.

## 8. Co je na implementátorovi

- Rozšířit `status.sh`, nebo přidat druhý skript pro plný report.
- Přesné texty výpisu `cache prune` (v duchu §4.5).
- Jak měřit velikost volume registry.
- Jak přesně rozpoznat odmítnutý `forwardOut` (text chyby `ssh2`).
- Jestli `ssh` bez příkazu bez terminálu pošle vstup shellu (`shell()` bez pty), nebo použije `exec` na `$SHELL`; obojí splní §4.2.
