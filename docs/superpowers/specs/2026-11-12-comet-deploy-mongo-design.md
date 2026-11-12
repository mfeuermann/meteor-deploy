# comet-deploy fáze 2, projekt 2: MongoDB na serveru (sekce `mongo`), návrh

- **Stav:** rozhodnutí autora, uživatel nechal rozsah i pořadí na něm („Nechávám to na tobě, začni tím nejdůležitějším“, 2026-11-12)
- **Datum:** 2026-11-12
- **Navazuje na:** hlavní návrh [`2026-11-07-comet-deploy-design.md`](2026-11-07-comet-deploy-design.md), hlavně §7.2 (zvláštnosti MUP: `mongo shell` používá `dbName`), §7.3 (stav na serveru, byte-identické šablony `mongo-start-*.sh`) a §13 (Mongo jako MUP, včetně omezení „jeden app server na stejném hostu“ a vynuceného `MONGO_URL`). Co tam je rozhodnuté, platí dál, pokud tento dokument neříká jinak. Strukturou navazuje na návrh proxy [`2026-11-11-comet-deploy-proxy-design.md`](2026-11-11-comet-deploy-proxy-design.md).
- **Referenční chování MUP:** [`docs/reference/mup-1.5.11.md`](../../reference/mup-1.5.11.md) §2.5 (volby `mongo`), §3.5 (příkazy `mongo`) a §7 (jak Mongo běží). Zdrojový kód MUP 1.5.11 je v devDependencies (`node_modules/mup/lib/plugins/mongo`) a slouží jako orákulum. Kde se píše „jako MUP“, platí přesné chování z reference a z toho kódu.

Značení: **[uživatel]** = rozhodl uživatel, **[hlavní návrh]** = rozhodnuto v hlavním návrhu, **[moje volba]** = rozhodnutí autora tohoto návrhu.

---

## 1. Proč

Cíl fáze 2 [uživatel]: comet-deploy má plně nahradit MUP i pro ostatní uživatele. Sekce `mongo` je dnes nejčastější překážka. Obsahuje ji ukázkový config z `mup init` i z `comet-deploy init`. comet-deploy na ní `deploy`, `reconfig`, `restart` i `rollback` zastaví („not supported yet“) a `setup` jen varuje.

Dřív schválené pořadí fáze 2 bylo proxy, hooks, mongo, … [uživatel]. Uživatel teď nechal výběr na mně. Mongo jde před hooks [moje volba]: hooks používá menšina configů, kdežto sekci `mongo` má každý config vytvořený přes `init`. Hooks jsou další projekt.

## 2. Cíle

1. **Config se sekcí `mongo` funguje beze změny.** Odpadne odmítnutí v `assertPhase1Supported` (`src/deploy/pipeline.ts`), varování v `setupAll` (`src/cli/commands/setup.ts`) a zástupný příkaz `mongo [command..]` v `src/cli/commands/phase2.ts`. Normalizace (`prepareMongo` v `src/config/normalize.ts`: vynucený `MONGO_URL`, `--link=mongodb:mongodb`) a validace (`mongoSchema`) už existují a zůstanou.
2. **Stejný stav na serveru jako po MUP 1.5.11** [hlavní návrh]: kontejner `mongodb` se stejnými parametry, image `mongo:<version>`, soubory `/opt/mongodb/mongo-start-new.sh`, `mongo-start-current.sh` a `mongodb.conf`, data v `dataPath` (výchozí `/var/lib/mongodb`), replica set `meteor`. Server jde střídavě obsluhovat MUPem a comet-deploy oběma směry. Vyrenderovaný `mongo-start-new.sh` je **byte po bytu** stejný jako od MUP, jinak by `mup mongo start` i comet-deploy zbytečně restartovaly databázi (MUP porovnává `-new` a `-current` po bytech).
3. **Všechny příkazy `mongo`** (`setup`, `start`, `stop`, `logs`, `shell`, `status`) a mongo část příkazů `setup` a `status`, jako MUP (§4).
4. **Lepší než MUP, se stejným stavem na serveru** [moje volba]:
   1. `deploy`, `reconfig`, `restart`, `rollback` a `start` předem zkontrolují, že na serverech aplikace běží kontejner `mongodb`. Bez něj by start aplikace selhal na `--link` a revert také (§4.3).
   2. Ochrana dat při změně `mongo.version`: comet-deploy odmítne přeskočit hlavní verzi MongoDB nebo přejít na starší. Takový start by databázi nespustil (§4.4).
   3. Žádné tiché přeskočení: když config nesplňuje omezení MUP, `setup` i `mongo start` řeknou proč, a `validate` varuje předem (§4.2).
   4. `mongo shell` se připojí k `dbName`, ne k `app.name` [hlavní návrh §7.2].

## 3. Necíle, anti-cíle, omezení

**Necíle:**
- Mongo na jiném serveru než aplikace, víc serverů aplikace s vestavěným Mongem, replica set přes víc serverů, autentizace v Mongu. MUP nic z toho nemá. Kdo to potřebuje, použije externí databázi (`app.env.MONGO_URL` bez sekce `mongo`).
- Zálohy a obnova databáze (`mongodump`) a automatická migrace dat mezi verzemi MongoDB.
- Jiné výchozí `mongo.version` než MUP (`3.4.24`). Změna by rozbila zaměnitelnost: `mup setup` by verzi vrátil zpět.
- `mongo.oplog` a `mongo.port` zůstávají bez účinku jako v MUP. `MONGO_OPLOG_URL` comet-deploy nenastavuje.

**Anti-cíle (neúspěch, i kdyby to „fungovalo“):**
- **Ztráta nebo poškození dat:** smazání `dataPath`, spuštění MongoDB na datech, která neumí otevřít, nebo `rm` čehokoli pod `dataPath`. comet-deploy data nikdy nemaže, ani `meteor destroy` (jako MUP).
- **Zbytečný restart databáze:** `setup`, `mongo setup`, `deploy` ani žádný jiný příkaz nesmí znovu vytvořit kontejner `mongodb`, když se jeho start skript nezměnil. `deploy`, `reconfig`, `restart`, `rollback`, `start` a `stop` aplikace na kontejner `mongodb` nesahají vůbec.
- Stav, po kterém by `mup mongo start`, `mup setup` nebo `mup deploy` dopadly jinak než na serveru, který spravuje jen MUP.
- Deploy, který spadne až v polovině kvůli zastavenému Mongu a pak nedokáže vrátit předchozí verzi.

**Omezení:**
- Skripty a šablona MUP (`assets/mongo-setup.sh`, `assets/mongo-start.sh`, `assets/mongo-stop.sh`, `assets/templates/start.sh`) se převezmou **byte po bytu** do `templates/mup/mongo/` a renderují se stejným EJS (`@zodern/ejs`, `src/remote/render.ts`) se stejnými proměnnými (`mongoVersion`, `mongoshCmd`, `mongoDbDir`). Vlastní skripty comet-deploy patří do `templates/comet/`.
- Vše běží přes `sudo` jako v MUP. MUP volá na několika místech `docker` bez `sudo` (`mongo-start.sh`: `docker ps`, `mongo shell`, `mongo status`), což spoléhá na skupinu `docker` ze setupu. Převzaté MUP skripty zůstávají beze změny. Vlastní příkazy comet-deploy (shell, status, kontroly) používají `sudo` [moje volba].
- Pravidla z hlavního návrhu platí dál: zámek, strategie, health check, snapshot a obnova konfigurace, historie, maskování tajných hodnot, `--servers` (respektují ho všechny příkazy).

## 4. Chování

### 4.1 `setup`, `mongo setup`, `mongo start`

- **`setup`** proběhne jako v MUP: `docker.setup` → `meteor.setup` → `mongo.setup` + `mongo.start` (MUP hook `post.default.setup` pluginu mongo) → `proxy.setup` (proxy je v MUP abecedně za mongem). Varování „mongo is not set up yet“ zmizí.
- **`mongo setup`** jako MUP: na serveru z `mongo.servers` spustí `mongo-setup.sh` (vytvoří `/opt/mongodb` a předá ho přihlášenému uživateli) a nahraje vyrenderovanou šablonu do `/opt/mongodb/mongo-start-new.sh`. Proměnné jsou `mongoVersion = mongo.version`, `mongoshCmd = 'mongosh'` pro hlavní verzi > 5, jinak `'mongo'` (MUP porovnává `version.split('.')[0] > 5`), a `mongoDbDir = mongo.dataPath || '/var/lib/mongodb'`.
- **`mongo start`** jako MUP: spustí `mongo-start.sh`. Ten při shodném `-new` a `-current` jen nastartuje zastavený kontejner, při rozdílu zkopíruje `-new` na `-current` a spustí ho, takže kontejner vytvoří znovu (data zůstanou). Před spuštěním proběhne kontrola verze z §4.4.
- **Výstup [moje volba]:** `setup` i `mongo start` řeknou jedním řádkem, co se stalo: „MongoDB is up to date (container kept)“, „MongoDB started“ nebo „MongoDB recreated: start script changed (version 6.0.13 → 6.0.20)“. Informaci vezmou z výstupu `mongo-start.sh` („Same start script“ / „Different start script“) a ze stavu kontejneru, MUP skript se kvůli tomu nemění.

### 4.2 Omezení „jeden server aplikace na stejném stroji“ [hlavní návrh, výstup moje volba]

MUP vestavěné Mongo nastaví, jen když má aplikace **právě jeden** server a ten je **stejný stroj** jako první server z `mongo.servers`. Jinak `mup setup` vypíše hlášku a Mongo přeskočí, `mup mongo start` ho přeskočí potichu. Aplikace se pak nespustí, protože `--link=mongodb:mongodb` nemá na co ukazovat.

comet-deploy:
- **`validate`** varuje, když omezení neplatí, a když má `mongo.servers` víc než jeden server (MUP použije jen první). Je to varování, ne chyba: MUP takový config přijme.
- **`setup`, `mongo setup` a `mongo start`** Mongo přeskočí jako MUP, ale vždy s jasnou hláškou proč a s doporučením externí databáze.
- **Stejný stroj** = stejný `host` a SSH port, stejně jako `uniqueHosts` v `src/cli/commands/setup.ts`. Stejná adresa s jiným portem je jiný stroj za přesměrováním portů. MUP porovnává jen host.
- `mongo stop`, `mongo logs`, `mongo shell` a `mongo status` omezení nekontrolují, stejně jako MUP. Pracují s prvním serverem z `mongo.servers` (shell, status) nebo se všemi (stop, logs).

### 4.3 Kontrola Monga před příkazy, které vytvářejí kontejner aplikace [moje volba]

Kontejner aplikace se spouští s `--link=mongodb:mongodb`. Docker ho bez běžícího kontejneru `mongodb` na stejném stroji odmítne spustit. Restart by tak shodil aplikaci a revert by selhal ze stejného důvodu.

- **Kdy:** config má sekci `mongo` a příkaz vytváří nebo startuje kontejner aplikace: `deploy`, `reconfig`, `restart`, `rollback`, `start` (i jejich varianty `meteor …`).
- **Co:** na každém serveru aplikace, na kterém příkaz poběží (s `--servers` jen na nich), musí běžet kontejner `mongodb`. U `deploy` je to součást preflightu, takže chyba přijde **před buildem** (stejně jako kontrola proxy, `facts.sh` / `evaluatePreflight`). Ostatní příkazy nemají preflight, kontrola u nich proběhne před prvním zásahem do kontejneru. Builder ji přidá tak, aby nezdržela, například jako jeden `docker inspect` v existujícím spojení.
- **Chyba:** název serveru a postup. Když `/opt/mongodb/mongo-start-new.sh` existuje (to je soubor, který `mongo-start.sh` potřebuje), nápověda je `comet-deploy mongo start`, jinak `comet-deploy setup`. Když na serveru neplatí omezení z §4.2, chyba to řekne místo nápovědy ke startu.
- `stop` a `logs` aplikace kontrolu nedělají.

### 4.4 Změna `mongo.version` [moje volba]

MongoDB umí otevřít data jen ze stejné nebo o jednu starší řady (release series), a jen pokud je `featureCompatibilityVersion` (FCV) nastavená na tu starší řadu. Přeskočení řady nebo přechod na starší řadu znamená, že `mongod` na existujících datech nenastartuje a kontejner se dokola restartuje. MUP to nehlídá.

- **Kdy:** `setup`, `mongo setup` a `mongo start`, když by se změnila verze v `/opt/mongodb/mongo-start-current.sh` (tedy když skript existuje a jeho `MONGO_VERSION` se liší od `mongo.version`). U `setup` a `mongo setup` se kontroluje **před** zápisem `mongo-start-new.sh`. Odmítnutý skript tak na serveru nezůstane a nespustí ho ani pozdější `mup mongo start`.
- **Řada** je `major.minor` (`4.4.29` → `4.4`, `6.0.13` → `6.0`). Pořadí řad (`3.4`, `3.6`, `4.0`, `4.2`, `4.4`, `5.0`, `6.0`, `7.0`, `8.0`, …) a podmínky upgradu builder převezme z dokumentace MongoDB a uvede v kódu odkaz na zdroj.
- **Pravidla:**
  - Stejná řada (změna patch verze): projde.
  - O jednu řadu výš: projde, jen když běžící Mongo hlásí FCV rovnou současné řadě. FCV se čte z běžícího kontejneru. Když Mongo neběží nebo FCV nejde přečíst, comet-deploy odmítne s vysvětlením.
  - Přeskočení řady nebo nižší řada: odmítne.
  - Verze, kterou nejde rozebrat (např. tag `latest` nebo `7`): projde s varováním, že kontrola neproběhla. Chování je pak jako v MUP.
- **Odmítnutí** vypíše současnou a novou verzi, důvod a postup: upgradovat po jedné řadě, mezi kroky nastavit FCV, s odkazem na dokumentaci MongoDB. Volba `--allow-mongo-version-change` u `setup`, `mongo setup` a `mongo start` kontrolu vypne, pro toho, kdo ví, co dělá (např. obnova ze zálohy do prázdného `dataPath`).
- **Po úspěšném upgradu o řadu** comet-deploy připomene, že před dalším upgradem je potřeba nastavit FCV na novou řadu, a ukáže příkaz.

### 4.5 Ostatní příkazy

| Příkaz | Chování |
|---|---|
| `mongo stop` | Jako MUP (`mongo-stop.sh`: `--restart=no`, `mongod --shutdown`, `rm -f`; data zůstanou). Na všech serverech z `mongo.servers`. |
| `mongo logs [opts]` | Jako MUP: `docker logs <opts> mongodb`. Volby `docker logs` se předávají stejně jako u `logs` a `proxy logs` (`logsPassthrough`). |
| `mongo shell` | Interaktivní `mongo` / `mongosh` (podle verze jako MUP) v kontejneru `mongodb` na prvním serveru z `mongo.servers`, připojený k **`dbName`** [hlavní návrh §7.2]. Terminál přes SSH s pseudo-terminálem, změnou velikosti okna a návratem do původního stavu terminálu i po chybě. Když lokální vstup není terminál (roura, test), funguje bez pseudo-terminálu, takže `echo 'db.stats()' \| comet-deploy mongo shell` vypíše výsledek. Kód exit je kód příkazu na serveru. |
| `mongo status [--overview]` | Jako MUP (stav kontejneru, počet restartů, od kdy běží, verze, připojení, storage engine; `--overview` zkrácený výpis). Navíc FCV [moje volba], kvůli §4.4. |
| `status` | Po tabulce aplikace připojí `mongo status` (MUP hook `post.default.status`), před stavem proxy. |

Pseudo-terminál a předávání vstupu z `mongo shell` se napíšou jako sdílená pomůcka nad `src/ssh/connection.ts`. Použijí ji i budoucí `ssh` a `meteor debug` z projektu drobných příkazů [moje volba].

Příkazy běží přes `ctx.runner` s názvy jako v MUP (`mongo.setup`, `mongo.start`, `mongo.stop`, `mongo.logs`, `mongo.shell`, `mongo.status`), aby na ně projekt hooks mohl navěsit `pre`/`post` hooky. `setupAll` přidá `mongo.setup` a `mongo.start` do `refuseHooks`, když config sekci `mongo` má.

### 4.6 Zámek [moje volba]

`setup`, `mongo setup`, `mongo start` a `mongo stop` získají zámek aplikace (`deploy.lock`) na jejích serverech, stejně jako příkazy proxy (návrh proxy §4.6). Restart databáze uprostřed deploye by shodil health check. Ostatní příkazy `mongo` jen čtou a zámek nepotřebují.

## 5. Testování

- **Unit:**
  - Vyrenderovaný `mongo-start-new.sh` je stejný jako u MUP 1.5.11 (orákulum `test/oracle/mup-oracle.ts`) pro verze `3.4.24`, `5.0.x` a `6.0.x` (přepnutí `mongo` / `mongosh`) a pro vlastní `dataPath`. Převzaté skripty jsou shodné se soubory v `node_modules/mup/lib/plugins/mongo/assets`.
  - Pravidla z §4.4: tabulka případů (patch, o řadu výš s FCV a bez, přeskočení, nižší řada, nerozebratelná verze, chybějící `-current`, `--allow-mongo-version-change`).
  - Pravidla z §4.2 a §4.3 (jeden server, stejný host s jiným portem, víc serverů v `mongo.servers`) a chybové hlášky.
- **Integrace na fake serverech** (`test/harness/fake-servers.ts`):
  - `setup` s `mongo` z prázdného serveru: kontejner `mongodb` běží, replica set `meteor` je inicializovaný. Druhý `setup` beze změn kontejner nevytvoří znovu (stejné ID).
  - Deploy aplikace, která Mongo skutečně používá: zapíše a přečte dokument přes `MONGO_URL` (např. HTTP endpoint ve variantě testovací aplikace, ne v `test/fixtures/sample-app`, kterou používají ostatní testy). Pak `reconfig`, `restart` a `rollback`. Data přežijí `mongo stop` + `mongo start` i změnu patch verze.
  - Zastavené Mongo: `deploy` skončí v preflightu před buildem, `restart` skončí před zásahem do kontejneru. Aplikace v obou případech zůstane, jak byla.
  - Odmítnutý skok verze: po `setup` s jednou řadou změna `mongo.version` o dvě řady → `mongo start` i `setup` odmítnou, kontejner ani `mongo-start-new.sh` se nezmění. Skutečný upgrade o jednu řadu na fake serveru je volitelný, rozhodne builder podle ceny (dva velké image z Docker Hubu).
  - `mongo shell` přes rouru (`db.runCommand({ping: 1}).ok` → `1`), `mongo logs --tail 5`, `mongo status`, `status`.
  - **Zaměnitelnost s MUP** (rozšíření `test/integration/interop.test.ts`): `mup setup` + `mup deploy` → comet-deploy `deploy`; comet-deploy `setup` → `mup mongo start` vypíše „Same start script“ a kontejner `mongodb` zůstane (stejné ID); `mup setup` po comet-deploy `setup` totéž.
- **Verze MongoDB v testech** volí builder tak, aby image existoval pro architekturu fake serverů lokálně i v CI (arm64 na Macu s Apple Silicon, amd64 na GitHubu). `3.4.24` arm64 image nemá.

## 6. Dokumentace

Anglické `README.md` a `docs/*` popíšou:
- `configuration.md`: sekce `mongo` (volby, výchozí `3.4.24` jako MUP a doporučení nastavit verzi, omezení §4.2, vynucený `MONGO_URL`, kde leží data);
- `commands.md`: příkazy `mongo`, `--allow-mongo-version-change`, mongo část `setup` a `status`;
- `migrating-from-mup.md`: odstranit řádek `mongo` z „what does not work yet“ a doplnit rozdíly (§2 bod 4);
- `troubleshooting.md`: Mongo neběží, odmítnutá změna verze a FCV;
- jak upgradovat MongoDB po řadách;
- poznámka o bezpečnosti jako v MUP: Mongo nemá heslo, port je jen na `127.0.0.1`, ale kontejnery ve výchozí síti Dockeru na stejném serveru se k němu dostanou;
- README: funkce a roadmapa (mongo hotové).

Zmínky „planned for phase 2“ u mongo zmizí (`phase2.ts`, `pipeline.ts`, `setup.ts`, dokumentace). Dokumentace nesmí zmiňovat konkrétní aplikace, servery ani IP adresy uživatele.

## 7. Na builderovi

- Rozdělení kódu (např. `src/mongo/*`, `src/cli/commands/mongo.ts`) a sdílení `runOnServers`, `renderTemplate`, `SshConnection` a reporteru.
- Jak spolehlivě zjistit „vytvořeno znovu / ponecháno“ pro výstup z §4.1.
- Jak číst FCV a verzi z běžícího kontejneru pro `mongo` i `mongosh`.
- Pomůcka pro interaktivní SSH (pseudo-terminál, raw režim, změna velikosti, obnova terminálu).
- Testovací aplikace s Mongem a verze MongoDB pro testy.

## 8. Kritéria úspěchu

1. Config se sekcí `mongo` (i ten z `comet-deploy init`) projde `setup` a `deploy` na fake serveru a aplikace čte a zapisuje data v Mongu.
2. Vyrenderovaný `mongo-start-new.sh` a převzaté skripty jsou shodné s MUP 1.5.11 (unit testy s orákulem).
3. Testy zaměnitelnosti s MUP z §5 projdou a databáze se při nich zbytečně nerestartuje.
4. Zastavené Mongo zastaví `deploy` před buildem a `restart` před zásahem do kontejneru.
5. Odmítnutá změna verze nezmění nic na serveru.
6. Lint, typecheck, build, unit, integrační a e2e testy jsou zelené.
