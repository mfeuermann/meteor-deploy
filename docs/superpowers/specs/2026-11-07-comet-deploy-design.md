# comet-deploy: rychlá náhrada Meteor Up (MUP), návrh

- **Stav:** návrh ke schválení
- **Datum:** 2026-11-07
- **Název [uživatel]:** `comet-deploy` (npm balíček i CLI příkaz `comet-deploy`, sekce voleb `cometDeploy`). Repo je zatím `github.com/mfeuermann/meteor-deploy`; přejmenování repozitáře rozhodne uživatel.
- **Referenční chování MUP:** [`docs/reference/mup-1.5.11.md`](../../reference/mup-1.5.11.md). Mapa chování MUP 1.5.11 vznikla přímo z kódu, ne z dokumentace. Kde tento návrh píše „jako MUP“, platí přesné chování popsané tam.

Značení: **[uživatel]** = rozhodl uživatel, **[návrh]** = navrhl jsem já a uživatel nevznesl námitku, **[moje volba]** = rozhodnutí autora návrhu, které uživatel zatím výslovně neviděl.

---

## 1. Proč

Uživatel nasazuje Meteor aplikace nástrojem MUP. Deploy na 4 servery trvá velmi dlouho a většinu času zabere „build na každém serveru“. Z kódu MUP 1.5.11 vyplývá proč:

1. `meteor build` a komprese do `bundle.tar.gz` (gzip level 9, jednovláknový JS zlib) proběhnou lokálně, jednou.
2. Pak MUP **postupně server po serveru**, ve čtyřech oddělených kolech:
   - nahraje celý tarball (u aplikace aaa-brain 138 MB),
   - na serveru spustí `docker build` s plným `npm install --unsafe-perm` (vrstvy se necachují, takže se instaluje vždy od nuly, včetně kompilace nativních modulů),
   - nahraje `start.sh` a `env.list`,
   - restartuje kontejner a čeká na deploy check.
3. Aplikace je ve výchozím stavu **zastavená během remote buildu** (`stopAppDuringPrepareBundle: true`) a pak znovu při restartu. Má tedy dva výpadky na každém serveru.

Wall time je zhruba lokální build plus součet přes všechny servery (upload + pull + build + konfigurace + start + check).

U aaa-brain tvoří 704 MB z 744 MB rozbaleného bundlu závislosti (`programs/server/npm`). Kód aplikace má desítky MB. Při běžné změně kódu se tedy zbytečně přenáší a znovu instaluje ~95 % objemu, a to na každém serveru zvlášť.

**Cíl nástroje [uživatel]:** build jednou na vývojářském PC (nebo v CI), hotový výsledek jen rozeslat na servery, se stejnou konfigurací jako MUP. Deploy má být výrazně rychlejší. Nástroj bude veřejně na GitHubu.

## 2. Cíle

1. **Plná náhrada MUP [uživatel]:** příkazy `setup`, `deploy`, `reconfig`, `restart`, `start`, `stop`, `logs`, `status`, `validate`, `init`, `ssh` a skupiny `meteor`, `mongo`, `proxy` (nginx + Let's Encrypt, vlastní certifikáty, sdílená proxy, load balancing) a `docker`.
2. **Stejná konfigurace [uživatel]:** existující `mup.js` + `settings.json` fungují beze změny. Navíc lze konfiguraci zapsat jako čistý JSON (`mup.json`).
3. **Výrazně rychlejší deploy [uživatel]:**
   - build proběhne jednou lokálně,
   - `npm install` se cachuje ve vrstvě a znovu běží jen při změně závislostí,
   - na servery se přenáší jen změněné vrstvy, a to **paralelně**,
   - když se vstupy nezměnily, build se přeskočí.
4. **Bezpečnější nasazení než MUP [návrh]:**
   - kontrola před buildem (preflight),
   - strategie canary (nejdřív jeden server, pak zbytek),
   - skutečný health check,
   - automatický návrat na předchozí verzi při selhání,
   - příkaz `rollback`,
   - nasazení bez výpadku za proxy,
   - zámek proti souběžným deployům.
5. **Přehlednost [návrh]:** průběh po serverech, časy fází, souhrn, automatický výpis logů při selhání a `history` (kdo, kdy, jaký commit).
6. **Obousměrná zaměnitelnost s MUP [návrh]:**
   - servery nasazené MUPem převezme bez `setup`,
   - po deployi tímto nástrojem musí na serveru dál fungovat `mup restart`, `mup logs`, `mup stop` a `mup deploy`.
7. **Veřejný open-source projekt [uživatel]:** srozumitelný README, licence MIT a CI.

## 3. Necíle (pro v1)

- **Docker Swarm** (`swarm.enabled`) [návrh]. Konfigurace se swarmem skončí srozumitelnou chybou.
- **Pluginy třetích stran do MUP** (`plugins: [...]`, např. `mup-aws-beanstalk`, `mup-redis`) [návrh]. Pole `plugins` vyvolá varování, že pluginy nejsou podporované. Hooks (§7.4) podporované jsou. API pro hooks navrhnout tak, aby šla podpora pluginů doplnit později.
- **Zastaralé volby MUP `app.ssl`, `app.nginx`, `docker.imageFrontendServer`** (deprecated od MUP 1.4, nahrazené `proxy`) [moje volba]. Skončí chybou s návodem na převod na `proxy`.
- **Build na serveru.** Build běží jen lokálně nebo v CI.
- **Webový dashboard, Kubernetes, notifikace** [návrh]. Notifikace jdou udělat přes hooks.
- **Nativní Windows** [moje volba]. Podporované jsou macOS a Linux, na Windows přes WSL2. Kód nemá Windows zbytečně vylučovat (cesty, `meteor.bat`), ale v1 se na něm netestuje.
- **Ověřování SSH host klíčů** [moje volba]. Chová se jako MUP (klíče neověřuje). Zdokumentovat jako známé omezení.

## 4. Anti-cíle (co by z toho udělalo neúspěch, i kdyby to „fungovalo“)

- Nástroj nechá server ve stavu, se kterým si MUP neporadí (vendor lock-in).
- Je pomalejší než MUP při změně kódu (hlavní scénář), nebo při prvním deployi či změně závislostí na 2 a více serverů. [moje volba, upřesnění] Výjimky, které se přijmou a zdokumentují:
  - **1 server + změna závislostí + build pod emulací** (Apple Silicon → amd64): může vyjít nastejno nebo mírně hůř, protože `npm install` s kompilací nativních modulů běží pod Rosettou/QEMU. MUP kompiluje nativně, ale na každém serveru zvlášť a sériově.
  - **Pomalý uplink:** objem dat při prvním deployi nebo změně závislostí je srovnatelný s MUP. Vrstva závislostí je komprimovaná zhruba stejně velká jako tarball MUP a base image si server stahuje z Docker Hubu sám, stejně jako v MUP. Přenos z jednoho uplinku na víc serverů naráz se ale dělí o šířku pásma. Relay distribuce (nahrát jednou a ostatní servery berou z prvního) a vzdálený builder nejsou ve v1.
- Tajné hodnoty (`MONGO_URL`, `METEOR_SETTINGS`, hesla) skončí v Docker image, v jeho historii (`docker history`), v lokálním registry nebo ve výstupu na terminál.
- Tichý částečný deploy: část serverů na nové verzi a část na staré, aniž by to výstup jasně řekl.
- Úprava konfigurace pro náš nástroj rozbije MUP. Nové volby nesmí MUP zabránit v práci (§12).

## 5. Omezení a předpoklady

- **Lokálně:**
  - Node.js ≥ 20 a Meteor (verze aplikace).
  - Docker s BuildKit/buildx: Docker Desktop na macOS, Docker Engine na Linuxu. **To je nový požadavek oproti MUP** (README to musí říct hned na začátku).
  - Preflight kontroluje, že Docker umí cílovou platformu (`docker buildx inspect`).
- **Architektura:** vývojář může mít arm64 (Apple Silicon) a servery typicky amd64. Image se staví pro architekturu serverů přes emulaci v Docker Desktop (Rosetta/QEMU). Emulace zpomalí jen vrstvu `npm install`, tedy jen při změně závislostí.
- **Servery:** jako u MUP.
  - Debian/Ubuntu (apt) pro `setup`, bash jako výchozí shell, SSH (heslo, klíč nebo agent).
  - Ne-root uživatel potřebuje sudo bez hesla.
  - Pro tunelový přenos (§9) musí být v `sshd` povoleno `AllowTcpForwarding` (výchozí stav je povoleno). Jinak se použije záložní přenos.
- **Výchozí base image:** `zodern/meteor`. Po `FROM` spustí `ONBUILD` instrukce, které nainstalují Node podle `ARG NODE_VERSION`. Kontejner pak spouští `/built_app/main.js` přes `/home/app/scripts/start.sh`. Verze Node se čte z `bundle/star.json` (`nodeVersion`, u aaa-brain 24.22.1), jinak z `.node_version.txt`, stejně jako v MUP (ref. §4.4).
- **Existující referenční uživatel:** aplikace aaa-brain (Meteor 3.5.4).
  - Dva servery v LAN, přihlášení `root` + heslo, externí Mongo, bez proxy.
  - `docker.image: zodern/meteor:latest`, `buildOptions.serverOnly`, `docker.args` pro časovou zónu, `settings.json` vedle `mup.js`.
  - **Jsou to produkční servery.** Nástroj se na nich smí zkoušet jen s výslovným souhlasem uživatele (§15).

## 6. Přehled: jak deploy funguje

```
lokálně                                        každý server (paralelně)
───────                                        ────────────────────────
0. načtení + validace mup.js/mup.json, settings
1. PREFLIGHT ───────────────────────────────▶  SSH, docker běží, uname -m, zámek, místo na disku
2. BUILD (jednou na každou cílovou architekturu)
   meteor build --directory  (přeskočí se, když se vstupy nezměnily)
   docker buildx build → mup-<app>:<verze>
3. ZÁMEK ───────────────────────────────────▶  /opt/<app>/config/deploy.lock
4. DISTRIBUCE ──────────────────────────────▶  docker pull base image (z Docker Hubu, chyba se ignoruje)
   lokální registry + SSH reverse tunel       docker pull 127.0.0.1:<port>/mup-<app>:<verze>
                                               (přenesou se jen chybějící vrstvy)
                                               běžící aplikace se zatím NEMĚNÍ
5. AKTIVACE (strategie, výchozí canary) ─────▶  1. server: přepnout tagy, zapsat start.sh+env.list,
                                                  spustit, health check
                                               pak ostatní servery paralelně
                                               při selhání: návrat na :previous + výpis logů
6. ÚKLID + HISTORIE ────────────────────────▶  zápis do historie, mazání starých verzí, uvolnění zámku
7. souhrn: časy fází, stav každého serveru
```

Hlavní zrychlení:

- `npm install` běží jednou a jen při změně závislostí.
- Na servery se přenáší jen nová vrstva s kódem.
- Distribuce běží paralelně.
- Odpadá gzip-9 tarball (v image módu se tarball vůbec nevytváří).
- Během přípravy nedochází k žádnému výpadku: aplikace se na serveru přepne až v kroku 5.

## 7. Kompatibilita s MUP

### 7.1 Načítání a validace konfigurace

- **Hledání souboru:**
  - `--config <cesta>` (`.js` i `.json`), jinak `./mup.js`, jinak `./mup.json`.
  - Automatické hledání `mup.json` je rozšíření [uživatel: „JSON konfigurační soubor“]. MUP sám `mup.json` nehledá.
- `settings.json`, `--settings`, `app` vs `meteor`, normalizace (`prepareConfig` pluginů meteor → mongo → proxy) a výchozí hodnoty se chovají **přesně jako MUP** (ref. §1, §2.9). Patří sem i deterministické hodnoty:
  - LB port `random-seed(app.name).intBetween(10000, 20000)`,
  - výchozí `buildLocation`,
  - `dbName`.

  Testovací vektory jsou v referenci (Appendix).
- **Rozlišení relativních cest** jako v MUP (některé cesty se berou od cwd, jiné od adresáře konfigurace, ref. §1). **[moje volba]** Rozšíření: když cesta relativní k cwd neexistuje, zkusí se relativně k adresáři konfigurace a vypíše se upozornění.
- **Validace [moje volba]:** stejná schémata jako v MUP (Joi), stejná místa chyb (`meteor.env.ROOT_URL` …). Jinak než MUP:
  - **Fatální** jsou jen chyby, kvůli kterým deploy nemůže fungovat: chybí `name`/`path`/`servers`, neplatný `ROOT_URL`, neexistující server v `app.servers`, swarm, zastaralé `app.ssl`.
  - Neznámé klíče a typové odchylky, které MUP v praxi toleruje, jsou **varování**. Typicky jde o extra `servers.*.opts` (předávají se do ssh2), `allowIncompatibleUpdate`, `ssl.upload` a `dockerImageFrontendServer`.
  - `validate` vrací exit 1 při jakémkoli problému (jako MUP). Podporuje `--show` a `--scrub` (ref. §2.10).

### 7.2 Zvláštnosti MUP: co replikovat a co opravit [moje volba]

| Zvláštnost MUP (ref. §12) | Náš nástroj |
|---|---|
| `--servers` se dělí mezerou, čárka nefunguje | Přijímá obojí. Respektují ho všechny příkazy včetně status a remote hooks. |
| `deployCheckPort` se ignoruje | Respektuje se (výchozí hodnota `docker.imagePort`). |
| Deploy check nemá `--fail`, takže i HTTP 500 projde | Health check vyžaduje HTTP status < 500 (konfigurovatelné, §12). |
| `allowIncompatibleUpdates` nefunguje, kód čte jednotné číslo | Fungují obě varianty. |
| Přepis ROOT_URL http→https zahodí `:` u portu | Opraveno: port zůstane. |
| `env.list` bez uvozovek, víceřádkové hodnoty ho rozbijí | Formát zůstává (kvůli zaměnitelnosti). Hodnota s novým řádkem je fatální chyba validace. |
| ARG s celým `app.env` v Dockerfile (tajné hodnoty v historii image) | ARG se nepřidávají. Výjimka: když jsou nastavené `buildInstructions`, přidají se ARG pro klíče, na které se instrukce odkazují (`$KEY`/`${KEY}`), a vypíše se varování. |
| Rollback v bundle módu je rozbitý (`mv last current`) | Opraveno. |
| `proxy envconfig` padá | Implementovat smysluplně (zapíše proxy env), nebo z nápovědy odstranit. Volba je na builderovi. |
| `mongo shell` používá `app.name` místo `dbName` | Používá `dbName`. |

Ostatní chování (pořadí normalizace, formát souborů, názvy kontejnerů) **replikovat přesně**.

### 7.3 Stav na serveru (zaměnitelnost s MUP)

Nástroj musí zachovat rozložení podle ref. §5:

- `/opt/<name>/config/start.sh` a `env.list`,
- kontejner `<name>`,
- image `mup-<lowercase name>` s tagy `:latest` a `:previous` (s registry `<imagePrefix>/mup-<lc>`),
- `/opt/mongodb/*`, `/opt/mup-nginx-proxy/*` a všechny kontejnery proxy a Mongo se stejnými jmény a parametry.

**Byte-identické šablony:** `start.sh`, `env.list`, `mongo-start-*.sh`, `proxy-config-container.sh` a skripty proxy se renderují **z původních MUP šablon** (MIT, s uvedením autorství) pomocí EJS 2.7.x se stejnými proměnnými. Důvod: MUP porovnává `mongo-start-current.sh` a `proxy-config-container.sh` po bytech. Při rozdílu by zbytečně restartoval Mongo nebo proxy.

**Co přidáváme (MUP to ignoruje):**

- další tagy `mup-<lc>:<verze>` pro rollback (§11),
- `/opt/<name>/config/deploy-history.jsonl`,
- `/opt/<name>/config/deploy.lock`.

`meteor destroy` uklidí i tyto věci.

**Bundle mód** (base image, který neumí prepare-bundle, např. `kadirahq/meteord`):

- Podporovaný jako kompatibilní cesta bez zrychlení buildu. `bundle.tar.gz` se nahrává **paralelně** do `/opt/<name>/tmp/`, pak `start.sh` jako v MUP.
- Pokud `docker.image` není nastavený, MUP použije `kadirahq/meteord` (bundle mód). **[moje volba]** Necháme stejný default kvůli kompatibilitě. Při deployi vypíšeme doporučení přejít na `zodern/meteor`. Moderní aplikace ho mají nastavený už dnes, aaa-brain také.

### 7.4 Hooks

- Stejné názvy jako v MUP: `pre.<plugin>.<příkaz>` / `post.<plugin>.<příkaz>` včetně zkratky `post.deploy` → `post.default.deploy`.
- Stejné formy: `localCommand`, `remoteCommand` a `method(api, nodemiral)` nebo funkce.
- Stejné pořadí (ref. §9.1).

**Vnoření příkazů:** deploy volá příkazy ve stejném vnoření jako MUP, aby hooks běžely ve stejných logických chvílích:

```
meteor.deploy
  meteor.push
    meteor.build
    meteor.prepareBundle      (lokální stavba image)
    distribuce
  default.reconfig
    meteor.envconfig
    meteor.start              (aktivace)
```

Mapování musí být zdokumentované v README.

**API pro `method` hooks:**

- Implementovat kompatibilní podmnožinu `PluginAPI`: `getArgs`, `getBasePath`, `getVerbose`, `getOptions`, `getConfig`, `setConfig`, `getSettings`, `getSettingsFromPath`, `runCommand`, `runSSHCommand`, `resolvePath`, `getDockerLogs`, `validateConfig`, `scrubConfig`, `commandHistory`, `settings` (ref. §9.3).
- Funkce závislé na nodemiral (`getSessions`, `runTaskList`) a swarmu nejsou ve v1. Volání vyhodí srozumitelnou chybu „není podporováno v comet-deploy“.
- Musí fungovat zdokumentovaný vzor `api.getSettings(); api.settings.X = …` v `pre.reconfig`.

## 8. Build (lokálně)

1. **Klíč cache vstupů:** deterministický hash z:
   - zdrojových souborů aplikace (bez `.meteor/local`, `node_modules`, `.git` a build adresáře),
   - `package.json`, `package-lock.json`, `.meteor/{release,versions,packages}`,
   - obsahu `node_modules`, stačí rychlá varianta: seznam balíčků + verze,
   - `buildOptions`, cílové architektury, verze nástroje a Dockerfile.

   Pokud hash odpovídá poslednímu buildu a image lokálně existuje, `meteor build` i stavba image se přeskočí. Chybné přeskočení je horší než zbytečný build, proto cache volí opatrné vstupy.

   Lokální stav cache je v uživatelském cache adresáři (např. `~/.cache/comet-deploy/<hash app path>/`), ne v repozitáři aplikace.

   Přepínače: `--cached-build` (jako MUP: použij poslední bundle bez ohledu na změny) a `--force-build`.
2. **`meteor build --directory <buildLocation> --architecture <os.linux.x86_64|os.linux.aarch64>`** s argumenty z `buildOptions` přesně jako MUP (ref. §4.1), včetně `METEOR_HEADLESS=1`. Jiné je jen `--architecture`: MUP ho má natvrdo x86_64, my ho bereme podle architektury serverů z preflightu. Tarball se v image módu nevytváří.
3. **Docker image** (`docker buildx build --platform linux/<arch>`). Dockerfile je generovaný tak, aby se **vrstva se závislostmi cachovala**:
   ```dockerfile
   FROM <docker.image>                 # ONBUILD: instalace Node podle NODE_VERSION
   <buildInstructions>                 # MUP je aplikuje jen při remote buildu, my vždy
   COPY <manifesty a skripty npm z programs/server + programs/server/npm/>  /built_app/programs/server/
   RUN cd /built_app/programs/server && npm install --unsafe-perm   # = vrstva závislostí
   COPY <zbytek bundlu>  /built_app/
   ```
   - `npm install` v `programs/server` spouští `node npm-rebuild.js`. Ten přestaví nativní moduly z `programs/server/npm` (seznam je v `npm-rebuilds.json`) pro cílovou platformu. Vrstva závislostí proto potřebuje **celý adresář `programs/server/npm`** a soubory, na kterých `npm install` / `npm-rebuild.js` závisí. Builder přesný seznam ověří na reálném bundlu Meteor 3.x (u aaa-brain obsahuje `programs/server` mimo jiné `package.json`, `npm-shrinkwrap.json`, `npm-rebuild.js`, `npm-rebuild-args.js` a `npm-rebuilds.json`).
   - **Povinné ověření:** dva po sobě jdoucí `meteor build` beze změny závislostí musí dát **cache hit** na vrstvě `npm install`. Klíč cache u `COPY` v BuildKit by neměl záviset na mtime, ale je to potřeba změřit. Pokud cache netrefí, builder zavede vlastní hash obsahu `programs/server/npm` a manifestů a postaví z něj samostatný „deps“ image s tagem podle hashe, ze kterého finální image vychází.
   - Zbytek bundlu nesmí přepsat `node_modules` vzniklé v kroku `npm install` ani duplikovat 700 MB `npm/` v další vrstvě (např. přes `.dockerignore` nebo cílený COPY).
   - `--build-arg NODE_VERSION=<z star.json>` jako MUP.
   - Tag: `mup-<lc>:<verze>`. `<verze>` = `YYYYMMDD-HHMMSS-<git sha7>[-dirty]`, bez gitu jen čas.
   - `docker.prepareBundle`, `prepareBundleLocally`, `useBuildKit` a `stopAppDuringPrepareBundle` se přijímají a ignorují: build je vždy lokální a s BuildKit. Zdokumentovat.
4. **Jeden stavěcí stroj ve v1 [uživatel: „teď já, později možná CI“]:** cache vrstvy závislostí stačí lokální (BuildKit cache na stroji, který staví). Když se změní stroj (jiný vývojář nebo čistý CI runner), vrstva závislostí dostane jiný digest a jednou se přenese celá. Ve v1 se to přijímá a dokumentuje.

   Návrh má ale nechat otevřenou cestu pro CI:
   - vrstvu závislostí identifikovat vlastním hashem obsahu (ne jen BuildKit cache), aby šlo později zavést sdílený „deps“ image podle hashe,
   - oddělit interně krok „build“ od kroku „distribuce + aktivace“, aby šly později přidat příkazy `build` a `deploy --image`.
5. **Více architektur:** pokud mají servery různé architektury, build (meteor i image) proběhne pro každou zvlášť. Každý server dostane image své architektury.

## 9. Přenos na servery

Režim `transfer` (§12), výchozí `auto`:

1. **`registry`**, pokud je nastavené `privateDockerRegistry`:
   - Lokálně `docker login` + push `<prefix>/mup-<lc>:<verze>`. Při více architekturách se pushne manifest list.
   - Servery paralelně pullují. `start.sh` (MUP formát, byte-identický) dělá `docker pull <prefix>/mup-<lc>:latest` sám, takže **o verzi rozhoduje sdílený tag `:latest` v registry**. Sémantika [moje volba]:
     - Na začátku aktivace (před canary) se v registry nastaví `:previous` = dosavadní `:latest` a `:latest` = nová verze (jako MUP, ref. §4.6).
     - Při jakémkoli selhání se `:latest` v registry vrátí na `:previous`, selhaný server se vrátí na starou verzi a souhrn jasně vypíše, které servery už běží na nové verzi (stejná situace nastává v MUP).
     - `rollback` v registry módu funguje jen pro všechny servery (přepne `:latest` v registry a restartuje všechny). `rollback --servers` v registry módu skončí chybou s vysvětlením.
2. **`tunnel`**, výchozí bez registry:
   - Lokálně běží kontejner `registry` (Docker Distribution, pevně daná verze), publikovaný jen na `127.0.0.1:<volný port>`. Má perzistentní volume, takže nezměněné vrstvy se při pushi nepřenášejí znovu. Mezi deployi se kontejner zastaví a volume zůstane. Úklid zajistí příkaz `comet-deploy cache prune` [moje volba].
   - Image se pushne do lokálního registry.
   - Ke každému serveru se otevře **SSH reverse tunel** (ssh2 `forwardIn`) z `127.0.0.1:<port na serveru>` na lokální registry. Server pak spustí `docker pull 127.0.0.1:<port>/mup-<lc>:<verze>`. Docker považuje registry na `127.0.0.0/8` za povolené i přes HTTP, takže na serveru není potřeba nic konfigurovat.
   - Server stáhne **jen vrstvy, které nemá**. Pak se image přetaguje na `mup-<lc>:<verze>` a tag s `127.0.0.1:` se odstraní.
   - Před pullem server zkusí `docker pull <docker.image>` z vlastního registry (jako MUP; chyba se ignoruje). Vrstvy base image tak nemusí jít přes tunel.
3. **`stream`**, záloha, když tunel nejde otevřít (např. `AllowTcpForwarding no`): `docker save | komprese | ssh 'docker load'`. Přenáší celý image. Vypíše se varování, že je to pomalejší, a doporučení zapnout forwarding.

**Společné vlastnosti:**

- Distribuce běží na všech serverech paralelně, ukazuje průběh po serverech (u přenosu velikost) a **nemění běžící aplikaci**.
- Konfigurační soubory (`start.sh`, `env.list`) se do `/opt/<name>/config/` zapisují až při aktivaci. MUP příkazy spuštěné mezitím (`mup restart`) tak dál pracují se starou verzí a starou konfigurací.

## 10. Aktivace, health check, rollback, nulový výpadek

### 10.1 Strategie (`strategy`, §12) [návrh]

- **`canary` (výchozí):** nejdřív jeden server celý (přepnutí + health check). Teprve když projde, zbytek paralelně. Pokud canary selže, ostatní servery zůstanou na staré verzi a deploy skončí chybou. Při load balancingu je během restartu zbytku vždy aspoň canary nahoře.
- **`rolling`:** server po serveru (chování MUP, jen bez build a upload kol).
- **`parallel`:** všechny najednou. Nejrychlejší, ale vhodné jen tam, kde výpadek všech serverů naráz nevadí.

Přepínač na CLI: `--strategy`.

### 10.2 Aktivace na jednom serveru

1. **Snapshot konfigurace:** dosavadní `start.sh` a `env.list` se zkopírují vedle (např. `config/.prev/`), aby šlo vrátit **image i konfiguraci** dohromady [moje volba].
2. Retag `mup-<lc>:latest` → `:previous` a `:<verze>` → `:latest` (registry viz §9).
3. Zápis `start.sh` a `env.list` (MUP formát, ref. §4.7).
4. Spuštění:
   - **Bez proxy nebo s `loadBalancing`** (aplikace publikuje port na hostu): `sudo bash /opt/<name>/config/start.sh`, stejná cesta jako `meteor-start.sh` v MUP (ref. §4.8). Výpadek trvá jen restart kontejneru a start Meteoru. Image už na serveru je a žádný build neběží.
   - **Za proxy bez `loadBalancing`** (nginx-proxy routuje podle `VIRTUAL_HOST` na IP kontejneru): **nulový výpadek** [návrh]. Postup:
     1. Nový kontejner se spustí vedle starého pod dočasným jménem (např. `<name>-next`) se **stejnými parametry, jaké by vytvořil `start.sh`**.
     2. Proběhne health check.
     3. nginx-proxy (docker-gen) mezitím nový kontejner přidá do upstreamu.
     4. Starý kontejner se zastaví gracefully (`docker stop -t <n>`, ne `rm -f`) a odstraní.
     5. Nový kontejner se přejmenuje na `<name>`.

     Výsledný stav musí být nerozlišitelný od kontejneru vytvořeného `start.sh` (jméno, `--restart=always`, env, sítě). `mup restart` pak normálně funguje. Builder ověří, že nginx-proxy po přejmenování a odstranění starého kontejneru generuje správný upstream a že během přepnutí nepadají HTTP požadavky. Ověřit testem se smyčkou požadavků; WebSocket spojení se smí přerušit a znovu připojit.

     **Záloha [moje volba]:** pokud se ukáže, že to s `zodern/nginx-proxy:v1.1.0` bez zásahu do MUP šablon a stavu proxy spolehlivě nejde, v1 nulový výpadek **nebude mít**. Za proxy se pak použije běžná cesta přes `start.sh` (jeden krátký výpadek) a README to uvede. Šablony ani verze proxy se kvůli tomu neměnit. Prototyp udělat na začátku implementace, aby se to rozhodlo brzy.
5. **Health check** [návrh]: smyčka nejvýš `deployCheckWaitTime` (výchozí 60 s) volá `http://<IP kontejneru>:<deployCheckPort|imagePort><healthCheck.path>`.
   - **Úspěch:** HTTP status v povoleném rozsahu (výchozí < 500).
   - **Okamžité selhání:** kontejner je ve stavu `exited` nebo `restarting` (crash loop).
   - Síť `host` se ošetří jako v MUP (ref. §4.9).
6. **Při selhání:**
   - výpis `docker inspect` stavu a posledních 100 řádků logu,
   - návrat na `:previous` **a na konfiguraci ze snapshotu** (retag + obnovení `start.sh`/`env.list` + `start.sh`). Tím se pokryje i případ, kdy chybu způsobil nový `settings.json` nebo env,
   - u `reconfig` (image se nemění) se vrátí jen konfigurace,
   - na serveru zůstane stará verze a deploy skončí chybou.

   Ostatní servery:
   - V canary/rolling se další servery nespustí.
   - V paralelní fázi ty, které už prošly, zůstanou na nové verzi. Souhrn to musí **jasně říct** (anti-cíl tichého částečného deploye) a nabídnout příkaz `rollback`.

   Automatický rollback všech serverů ve v1 není [moje volba].

### 10.3 `reconfig`, `restart`, `start`, `stop`

- Chování jako v MUP (ref. §3.2, §3.3). `reconfig` a `restart` ale používají stejnou strategii a health check jako deploy.
- `start` a `stop` jsou paralelní.

## 11. Nové funkce oproti MUP

| Funkce | Popis |
|---|---|
| **Preflight** | Před buildem paralelně na všech cílových serverech: SSH spojení, běžící Docker (verze ≥ 18 jako MUP), `uname -m`, volné místo pro Docker (varování pod prahem), stav zámku. Lokálně: Docker, buildx, podpora platformy, `meteor`. Chyby se objeví hned, ne po několikaminutovém buildu. |
| **`rollback [--to <verze>] [--servers …]`** | Přepne `:latest` na předchozí (nebo zvolenou) verzi, která zůstala na serveru, spustí `start.sh` a health check podle strategie. Na serveru se drží posledních `keepVersions` verzí (výchozí 5), starší tagy se mažou při úklidu. Funguje za pár sekund, nic se nestaví ani nepřenáší. **Vrací jen image, aktuální konfigurace zůstává** [moje volba]. Důvod: staré kopie `env.list` by mohly vrátit už vyměněná hesla. Obnova konfigurace se dělá přes `reconfig` s opravenou konfigurací. Registry mód viz §9. |
| **`history [--limit N]`** | Čte `/opt/<name>/config/deploy-history.jsonl` ze serverů a ukáže je sloučené: čas, verze, git commit + větev + dirty, kdo nasazoval (git `user.name`, jinak OS uživatel), stroj, výsledek, doba trvání a servery. Záznam se zapisuje při deployi, rollbacku i reconfigu. |
| **Zámek deploye** | `deploy`, `reconfig`, `rollback` a `restart` získají před změnou zámek na všech cílových serverech: atomický `mkdir /opt/<name>/config/deploy.lock` s `info.json` (kdo, kdy, odkud, PID). Když je obsazený, příkaz skončí a vypíše držitele. Zámek se uvolní i při chybě a při Ctrl+C. Bez automatické expirace [moje volba]: zastaralý zámek se uvolní příkazem `unlock` (nebo `--force-unlock`). |
| **Výstup** | Fáze s časy, průběh po serverech (TTY: živé řádky; mimo TTY/CI: jednoduché řádky bez escape sekvencí), na konci souhrnná tabulka (server → verze, výsledek, čas). `--verbose` streamuje vzdálený výstup jako MUP. Tajné hodnoty se nikdy nevypisují. |
| **Paralelní `setup`** | Všechny kroky setupu, které spolu nesouvisí, běží paralelně přes servery (MUP část dělá sériově). |

## 12. Nové volby konfigurace

Nové volby jsou v **samostatné top-level sekci** `cometDeploy`. MUP neznámý top-level klíč vypíše jako chybu validace, ale deploy nepřeruší (ref. §1). Konfigurace tak zůstane použitelná oběma nástroji. Všechny volby jsou nepovinné a mají rozumné výchozí hodnoty. Většina má i CLI přepínač.

```js
cometDeploy: {
  strategy: 'canary',          // 'canary' | 'rolling' | 'parallel'
  transfer: 'auto',            // 'auto' | 'tunnel' | 'registry' | 'stream'
  platform: 'auto',            // 'auto' (podle uname -m serverů) | 'linux/amd64' | 'linux/arm64'
  keepVersions: 5,
  zeroDowntime: true,          // uplatní se jen za proxy bez loadBalancing
  healthCheck: {
    path: '/',
    maxStatus: 499,            // úspěch = status <= maxStatus
    // timeout = app.deployCheckWaitTime (MUP volba), port = app.deployCheckPort || docker.imagePort
  },
  lock: true,
}
```

Builder smí názvy a tvar doladit, pokud zachová princip: jedna sekce, žádná změna významu existujících MUP voleb.

## 13. Setup, proxy, Mongo, docker

- **`setup`:** stejný výsledek jako `mup setup` (ref. §3.2, §8):
  - instalace Dockeru přes get.docker.com na apt systémech, pokud chybí nebo je starší než 18,
  - adresáře `/opt/<name>`,
  - Mongo (`mongo.*`),
  - proxy (`proxy.*`) včetně custom certifikátů, `vhost.d`, load balancing upstreamů a busybox konfiguračního kontejneru.

  Stejné skripty (MUP šablony), ale paralelně, kde to jde.
- **Proxy:** stejné image a verze jako MUP 1.5.11 (`zodern/nginx-proxy:v1.1.0`, `jrcs/letsencrypt-nginx-proxy-companion:v1.13.1`), stejné soubory a kontejnery. Všechny příkazy `proxy *` jako v MUP (ref. §3.6). Aktualizace verzí proxy image není ve v1 [moje volba], protože by porušila zaměnitelnost s MUP.
- **Mongo:** jako MUP (ref. §3.5, §7), včetně omezení „jeden app server na stejném hostu“ a vynuceného `MONGO_URL`.
- **`docker setup|update|restart|ps|status`:** jako MUP. `destroy-cluster` jen vypíše, že swarm není podporovaný.
- **`meteor debug`, `ssh`, `status`, `init`:** jako MUP. `init` navíc umí `--json` a vytvoří `mup.json`.

## 14. Technologie a struktura [moje volba]

- **Jazyk a balíček:** TypeScript, Node.js ≥ 20, npm balíček s CLI binárkou. Načítání `mup.js` (CommonJS `module.exports`) funguje i z ESM přes `createRequire`, vždy s vyčištěnou require cache jako MUP.
- **Klíčové knihovny:**
  - `ssh2`: SSH, SFTP, `forwardIn` pro tunel; auth `pem` > `password` > agent jako MUP; `servers.*.opts` se předávají do ssh2,
  - `yargs`: kompatibilní parsování včetně předávání argumentů `logs -f --tail 50`,
  - `joi`: přenesená MUP schémata,
  - `ejs` 2.7.x: byte-identické šablony,
  - `random-seed` + `uuid`: deterministické hodnoty,
  - `lodash.merge`: stejná sémantika slučování env.

  Lokální Docker se ovládá přes `docker` CLI.
- **Struktura (doporučení, builder upraví):**
  - `src/cli` (příkazy),
  - `src/config` (načtení, normalizace, validace, scrub),
  - `src/ssh` (session pool, exec, sftp, tunel),
  - `src/build` (meteor build, hash vstupů, Dockerfile, buildx),
  - `src/transfer` (registry/tunnel/stream),
  - `src/deploy` (preflight, zámek, distribuce, aktivace, health check, historie),
  - `src/plugins/{meteor,mongo,proxy,docker}` (příkazy a šablony),
  - `src/hooks` (hooks + kompatibilní API),
  - `templates/` (MUP šablony),
  - `test/`.
- **Licence:** MIT. Soubor NOTICE uvede autorství převzatých MUP šablon (MIT, © Kadira Inc. a přispěvatelé MUP).
- **Dokumentace:** anglicky (veřejný projekt) [moje volba]:
  - README: proč, rychlý start, požadavky, migrace z MUP, rozdíly oproti MUP, nové volby, benchmark,
  - `docs/` s podrobnostmi.

  Commity anglicky.
- **CI:** GitHub Actions: lint, typecheck, unit testy, integrační testy na Linux runneru. Publikace na npm z tagu.

## 15. Testování a ověření

1. **Unit testy, kompatibilita konfigurace:** `mup@1.5.11` jako devDependency slouží jako **orákulum**. Pro sadu fixture konfigurací (včetně příkladů z dokumentace MUP a konfigurace ve tvaru aaa-brain s fiktivními hodnotami) se porovná:
   - normalizovaná konfigurace (`validate --show`) s výstupem MUP,
   - vyrenderované `start.sh`, `env.list`, `mongo-start*.sh` a `proxy-config-container.sh` s výstupem MUP šablon, byte po bytu,
   - deterministické hodnoty s testovacími vektory z reference.
2. **Integrační testy, „falešné servery“:** Docker kontejnery se `sshd` + Docker-in-Docker (heslo i klíč). Scénáře:
   - `setup` → `deploy` → `reconfig` → `restart` → `rollback` → `stop`/`start`,
   - proxy s Let's Encrypt staging nebo vlastním certifikátem,
   - load balancing a Mongo,
   - selhání health checku a návrat,
   - zamčený deploy,
   - fallback `stream` při vypnutém forwardingu,
   - **zaměnitelnost s MUP:** `mup setup` + `mup deploy` → náš `deploy` → `mup restart`, `mup logs` a `mup deploy` dál fungují, a obráceně,
   - nulový výpadek: smyčka HTTP požadavků přes proxy během deploye nezaznamená chybu.
3. **E2E:** malá Meteor 3.x aplikace s nativním modulem (aby se ověřil rebuild pro cílovou platformu) přes celý deploy. Druhý deploy po změně jen kódu musí ukázat cache hit na vrstvě závislostí a přenos jen malé vrstvy.
4. **Benchmark:** stejná aplikace a stejné falešné servery (1, 2 a 4), MUP vs náš nástroj, tři scénáře:
   - první deploy,
   - změna kódu,
   - změna závislostí.

   Výsledek jde do README.

   Falešné servery na stejném Macu mají architekturu Macu a komunikují přes loopback, takže samy nestačí. Benchmark proto poběží i:
   - na amd64 Linux CI runneru (build i servery amd64, bez emulace),
   - na skutečném amd64 serveru z Macu (cesta s emulací), viz §17.
5. **Reálné servery:**
   - Uživatel má **neprodukční testovací Linux server** [uživatel] a přístup k němu poskytne, až bude potřeba. Architekturu zjistí preflight. Na něm proběhne akceptační test z Macu (build pod emulací, je-li server amd64) a benchmark proti MUP.
   - Produkční servery aaa-brain jsou **zakázané bez výslovného svolení** uživatele v danou chvíli.

## 16. Kritéria úspěchu

- Konfigurace aaa-brain (a fixture z dokumentace MUP) projde beze změny. `validate --show` dá stejnou normalizovanou konfiguraci jako MUP, kromě oprav z §7.2.
- **Deploy po změně jen kódu** (závislosti beze změny), 2–4 servery v LAN: čas od konce `meteor build` do „všechny servery healthy“ je **≤ 60 s + 2× čas startu aplikace** při výchozí strategii `canary` (canary, pak zbytek), resp. **≤ 60 s + 1× čas startu** při `parallel`. Přenese se jen vrstva s kódem (jednotky až desítky MB na server místo celého bundlu).
- **První deploy** na čistý server není pomalejší než MUP (ověřeno benchmarkem).
- Během deploye za proxy bez load balancingu nespadne žádný HTTP požadavek. Bez proxy je výpadek na server jen restart kontejneru a start aplikace (MUP: dva výpadky, z toho jeden přes celý `npm install`).
- Servery nasazené tímto nástrojem dál obsluhuje MUP a obráceně (integrační test).
- Selhání health checku na canary nechá všechny servery na staré, funkční verzi.

## 17. Rozhodnutí

**Rozhodl uživatel:**

- plná náhrada MUP včetně proxy a setupu,
- build jednou lokálně,
- stejná konfigurace (JSON/JS),
- cílem je rychlost,
- veřejně na GitHubu,
- „udělat to lépe než MUP“; uživatel nevznesl námitku proti seznamu vylepšení v §2 bod 4–5 a §11.

**Moje volby** (k revizi uživatelem; podrobnosti jsou v textu označené [moje volba]):

1. TypeScript/Node ≥ 20, npm balíček, MIT.
2. Přenos bez externího registry: lokální registry + SSH reverse tunel; záloha stream.
3. Výchozí strategie `canary`, bez automatického rollbacku všech serverů.
4. Validace: fatální jen to, co deploy rozbije, zbytek jsou varování.
5. Opravy zvláštností MUP podle §7.2.
6. Zastaralé `app.ssl`/`app.nginx`, swarm a pluginy třetích stran mimo v1.
7. Bundle mód podporovaný, ale bez zrychlení.
8. Verze proxy image stejné jako MUP.
9. macOS + Linux (Windows přes WSL2).
10. Dokumentace a commity anglicky.
11. Zámek bez automatické expirace.
12. Upřesněný anti-cíl rychlosti (§4): výjimky pro 1 server pod emulací a pomalý uplink, bez relay a remote builderu ve v1.
13. Registry mód: sdílený `:latest` a rollback jen pro všechny servery (§9).
14. Automatický návrat vrací image i konfiguraci, ruční `rollback` jen image (§10.2, §11).
15. Pokud nulový výpadek s MUP proxy spolehlivě nejde, v1 bez něj (§10.2).

**Nechávám na builderovi:**

- přesné rozdělení modulů a CLI framework,
- formát výstupu (v rámci požadavků §11),
- formát verze,
- implementační detaily cache vstupů (v rámci požadavku „raději zbytečný build než chybné přeskočení“),
- volba komprese pro `stream`,
- detaily nulového výpadku (v rámci požadavků §10.2),
- řešení `proxy envconfig`.

**Rozhodl uživatel po kontrole návrhu:**

- název `comet-deploy`,
- ve v1 staví jeden stroj, později možná CI (§8 bod 4),
- k dispozici je testovací server (§15 bod 5).

**Otevřené:** žádné. Přejmenování GitHub repozitáře z `meteor-deploy` na `comet-deploy` je volitelné a rozhodne uživatel.
