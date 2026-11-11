# comet-deploy fáze 2, projekt 1: reverzní proxy, návrh

- **Stav:** návrh ke schválení
- **Datum:** 2026-11-11
- **Navazuje na:** hlavní návrh [`2026-11-07-comet-deploy-design.md`](2026-11-07-comet-deploy-design.md), hlavně §10.2 (nulový výpadek za proxy) a §13 (setup a proxy). Co tam je rozhodnuté, platí dál, pokud tento dokument neříká jinak.
- **Referenční chování MUP:** [`docs/reference/mup-1.5.11.md`](../../reference/mup-1.5.11.md), hlavně §2.4 (volby `proxy`), §3.6 (příkazy `proxy`) a §6 (jak proxy funguje). Zdrojový kód MUP 1.5.11 je v devDependencies (`node_modules/mup/lib/plugins/proxy`) a slouží jako orákulum. Kde se píše „jako MUP“, platí přesné chování z reference a z toho kódu.

Značení: **[uživatel]** = rozhodl uživatel, **[návrh]** = navrhl jsem já a uživatel nevznesl námitku, **[moje volba]** = rozhodnutí autora návrhu, které uživatel zatím výslovně neviděl.

---

## 1. Proč

Fáze 1 (hotová, na `main`) umí deploy bez sekcí `proxy`, `mongo` a `hooks`. Config se sekcí `proxy` dnes skončí chybou „not supported yet“. Cíl fáze 2 [uživatel]: comet-deploy má **plně nahradit MUP i pro ostatní uživatele**, ne jen pro autora, takže musí fungovat s jakýmkoli existujícím `mup.js`.

Fáze 2 má šest samostatných projektů v pořadí, které schválil uživatel: **proxy**, hooks, mongo, bundle mód, další způsoby přenosu, drobné příkazy. Tento dokument popisuje jen první z nich. Proxy je první, protože ji podle odhadu používá většina MUP configů (přes ni lidé dostávají HTTPS).

## 2. Cíle

1. **Config se sekcí `proxy` funguje beze změny.** Odpadne odmítnutí v `assertPhase1Supported` (`src/deploy/pipeline.ts`), varování v `setupAll` (`src/cli/commands/setup.ts`) a zástupný příkaz `proxy` v `src/cli/commands/phase2.ts`. Normalizace a validace sekce `proxy` už existují (`src/config/normalize.ts` `prepareProxy`, `src/config/schema.ts` `proxySchema`) a zůstanou.
2. **Stejný stav na serveru jako po MUP 1.5.11** [uživatel, z hlavního návrhu]: stejné image a verze (`zodern/nginx-proxy:v1.1.0`, `jrcs/letsencrypt-nginx-proxy-companion:v1.13.1`), stejné soubory v `/opt/mup-nginx-proxy` a `/opt/<app>/config`, stejné kontejnery (`mup-nginx-proxy`, `mup-nginx-proxy-letsencrypt`, `mup-proxy-configure-<app>`), stejné sítě. Server se dá střídavě obsluhovat MUPem a comet-deploy oběma směry: `mup proxy setup`, `mup deploy`, `mup proxy logs` atd. musí po comet-deploy fungovat a naopak.
3. **Všechny příkazy `proxy` a proxy část ostatních příkazů**, jako MUP (§5).
4. **Lepší než MUP, a přitom se stejným stavem na serveru:**
   1. `deploy` a `reconfig` samy promítnou změny souborů proxy pro aplikaci, bez restartu proxy kontejnerů [uživatel] (§4.2).
   2. `setup`, `proxy setup` a `proxy reconfig-shared` znovu vytvoří proxy kontejnery jen tehdy, když se změnilo něco, z čeho se vytvářejí [návrh] (§4.1).
   3. Deploy bez výpadku za proxy bez load balancingu [návrh, z hlavního návrhu §10.2] (§4.3).
   4. Při load balancingu se server před restartem dočasně vyřadí z upstreamu na všech proxy [uživatel] (§4.4).
5. **Ověření jen lokálně** [uživatel]: na fake serverech v Dockeru (`test/harness/fake-servers.ts`) včetně vydání certifikátu přes lokální testovací ACME server (Pebble). Test na skutečném serveru s veřejnou doménou se nedělá.

## 3. Necíle, anti-cíle, omezení

**Necíle:**
- Docker Swarm, včetně proxy kontejneru `mup-nginx-proxy-swarm-upstream` (jako v hlavním návrhu).
- Novější verze proxy image nebo změny šablony `nginx.tmpl` [uživatel, z hlavního návrhu]. Výjimku smí přinést jen §6 (Docker 29) a o ní rozhodne uživatel.
- Zastaralé volby `app.ssl`, `app.nginx` a `docker.imageFrontendServer` (jako v hlavním návrhu: chyba s návodem).
- Test na skutečném serveru s veřejnou doménou a Let's Encrypt [uživatel].
- `proxy envconfig`: MUP ho má v nápovědě, ale handler neexistuje a spadne na TypeError. comet-deploy vypíše srozumitelnou chybu, že tento příkaz nemá v MUP 1.5.11 žádnou implementaci [moje volba].

**Anti-cíle (neúspěch, i kdyby to „fungovalo“):**
- Deploy, reconfig, rollback nebo restart jedné aplikace **restartuje proxy kontejnery** a tím shodí ostatní aplikace na stejném serveru.
- Server **zůstane potichu** vyřazený z upstreamu, ať už po pádu deploye, Ctrl+C nebo výpadku spojení.
- Vyřazení **všech** serverů z upstreamu naráz (proxy by vracela 502).
- Stav, po kterém by `mup proxy setup` nebo `mup deploy` dopadly jinak než na serveru, který spravuje jen MUP.
- Výpis tajných hodnot: obsah privátního klíče certifikátu, `shared.env`, `shared.envLetsEncrypt` a hodnot z `env.list`. E-mail pro Let's Encrypt se maskuje jako v `validate --scrub`.

**Omezení:**
- MUP skripty a šablony proxy se převezmou **byte po bytu** do `templates/mup/proxy/` (stejně jako `templates/mup/meteor` a `templates/mup/docker` ve fázi 1) a renderují se stejným EJS (`@zodern/ejs`, `src/remote/render.ts`). Vlastní skripty comet-deploy patří do `templates/comet/`.
- Vše běží přes `sudo` jako v MUP. Docker ≥ 18.
- Pravidla z hlavního návrhu platí dál: zámek deploye, canary/rolling/parallel strategie, health check, snapshot a obnova konfigurace, historie a maskování tajných hodnot.

## 4. Chování

### 4.1 `setup`, `proxy setup`, `proxy start`, `proxy reconfig-shared`

- **`setup`** proběhne jako v MUP: `docker.setup` → `meteor.setup` → (Mongo je samostatný projekt) → `proxy.setup` (MUP hook `post.setup`), a když je zapnutý load balancing, i konfigurační kontejner z `post.proxy.setup` (ref. §6.5, `service-configure.sh`). Kroky, které spolu nesouvisí, běží paralelně přes servery jako ve fázi 1.
- **`proxy setup`** udělá totéž co v MUP (ref. §3.6) na proxy serverech (`proxy.servers`, jinak servery aplikace):
  - `proxy-setup.sh`,
  - nahraje `start.sh` a `nginx.tmpl`,
  - spustí `nginx-config.sh` (vhost.d pro každou doménu) a `ssl-cleanup.sh`,
  - u vlastních certifikátů je nahraje a spustí `ssl-setup.sh`,
  - spustí `upstream.sh`,
  - nakonec `proxy.start`.
- **Rozdíl proti MUP [návrh]:** `proxy.start` v rámci `setup`, `proxy setup` a `proxy reconfig-shared` znovu vytvoří proxy kontejnery **jen tehdy, když je potřeba**: některý ze souborů, ze kterých se kontejnery vytvářejí, se změnil (`/opt/mup-nginx-proxy/config/start.sh`, `shared-config.sh`, `env.list`, `env_letsencrypt.list`, `nginx-default.conf`, `nginx.tmpl` / `nginx-shared.tmpl`), nebo kontejnery neexistují či neběží. Jinak vypíše, že proxy je aktuální, a nic nerestartuje. Jak změnu pozná (porovnání obsahu před zápisem, otisk uložený na serveru…), je na builderovi. Na serveru ale nesmí přibýt nic, co by MUP rozbilo.
- Pokud se kontejnery nevytvoří znovu, ale změnily se soubory pro aplikaci (vhost.d, certifikáty, upstream), musí se změna projevit stejně jako v §4.2.
- Soubor `upstream/<app>` zapisuje comet-deploy sám se stejným výsledkem jako MUP `upstream.sh`, ale **zachová v něm značky `down`** (§4.4) [moje volba]. Proto `setup` ani `proxy setup` nevrátí do provozu server, který neprošel health checkem. MUP vlastní `mup proxy setup` značky smaže, a to comet-deploy ovlivnit nemůže. Dokumentace to uvede.
- **`proxy start`** vytvoří kontejnery znovu **vždy**, jako MUP. Je to vědomá cesta k vynucení restartu proxy.
- **`proxy reconfig-shared`** jako MUP (ref. §3.6): nahraje sdílené soubory a pak proxy restartuje, ale jen podle pravidla výše. Běží sériově jako v MUP, protože restart proxy shodí všechny aplikace na serveru [moje volba: ponechat sériově].

### 4.2 Promítnutí souborů proxy při `deploy` a `reconfig` [uživatel]

MUP při `deploy` aktualizuje jen proměnné prostředí kontejneru (`VIRTUAL_HOST`, `LETSENCRYPT_*`, `HTTPS_METHOD`…). Soubory proxy pro aplikaci obnovuje jen `mup setup` / `mup proxy setup` (ref. §6.1). comet-deploy je při `deploy` a `reconfig` obnoví samo.

- **Co se promítá (soubory pro aplikaci):**
  - `vhost.d/<doména>` (`clientUploadLimit`, `nginxServerConfig`),
  - `vhost.d/<doména>_location` (`nginxLocationConfig`),
  - vlastní certifikáty (`ssl.crt`/`ssl.key`, pokud `ssl.upload` není `false`) a jejich odkazy a kopie v `certs/` a `mounted-certs/`,
  - u load balancingu soubor `upstream/<app>`, odkazy `vhost.d/<doména>_upstream` a konfigurační kontejner `mup-proxy-configure-<app>`.

  Obsah musí být **přesně takový, jaký by vytvořil `mup proxy setup`** se stejným configem (stejné skripty MUP, nebo jejich výstup ověřený orákulem).
- **Jen změny:** přepíše se jen to, co se liší, a výstup řekne, co se změnilo. Když se nezměnilo nic, deploy ani nezdrží.
- **Kdy:** při `deploy` a `reconfig` na proxy serverech. `rollback` a `restart` soubory proxy nemění: rollback vrací jen image (hlavní návrh §11) a restart nic nemění.
- **Pořadí: soubory proxy nikdy nesmí ukazovat na něco, co ještě (nebo už) neběží** [moje volba]. Soubory pro doménu (vhost.d, `_location`, certifikáty) se zapíšou před aktivací. U souborů load balancingu záleží na tom, jak se mění:
  - **Zapnutí `loadBalancing`:** upstream, odkazy `_upstream` a konfigurační kontejner se zapíšou až po aktivaci všech serverů. Do té doby nginx routuje podle IP kontejnerů jako bez load balancingu, a to funguje se starými i novými kontejnery.
  - **Vypnutí `loadBalancing`:** upstream a odkazy se odstraní a nginx konfigurace se znovu vygeneruje před aktivací.
  - **Změna portu nebo adresy serveru (`app.env.PORT`, `privateIp`, `host`) při load balancingu:** položka serveru v upstreamu se změní až při aktivaci toho serveru, spolu s vyřazením z §4.4. Položky ostatních serverů zůstanou, dokud nejsou na řadě.
  - **Přidaný server** se do upstreamu přidá až po úspěšné aktivaci.
  - **Odebraný server** se z upstreamu odstraní na začátku.

  Pokud builder narazí na změnu, kterou takhle bezpečně provést nejde, deploy ji odmítne s návodem a nepokusí se o ni.
- **Značky `down`** (§4.4) zůstávají při přepisu upstreamu zachované u všech serverů, které tento běh nerestartuje [moje volba].
- **Jak se změna projeví [pozor, důležité]:** nginx konfiguraci (`/etc/nginx/conf.d/default.conf`) generuje docker-gen ze šablony `nginx.tmpl`. Šablona rozhoduje, zda soubor `vhost.d/<host>`, `<host>_location`, `<host>_upstream` nebo certifikát pro doménu existuje, **v okamžiku generování**. Pouhé `nginx -s reload` tedy stačí jen na změnu obsahu souboru, který už byl zahrnutý. Nový nebo odstraněný soubor vyžaduje nové vygenerování. MUP to řeší tím, že po setupu proxy kontejnery znovu vytvoří, což comet-deploy dělat nesmí (anti-cíl). Builder zvolí spouštěč nového generování bez restartu proxy kontejnerů a ověří ho čtením vygenerovaného `default.conf`. Možnosti jsou například jednorázový běh `docker-gen` uvnitř `mup-nginx-proxy` se stejnými parametry jako v image, nebo událost kontejneru, kterou docker-gen sleduje.
- **Sdílené nastavení** (`proxy.shared.*`) se při deployi **nepromítá**, protože vyžaduje restart proxy. Proxy je společná pro všechny aplikace na serveru, ale `shared` přichází z configu jedné z nich. Deploy proto varuje (s příkazem `comet-deploy proxy reconfig-shared`) **jen tehdy, když config aplikace sekci `shared` obsahuje** a její účinek se liší od stavu na serveru [moje volba]. Config bez `shared` nikdy nevaruje, aby nevedl k přepsání nastavení jiné aplikace. „Účinek“ znamená porovnání hodnot (porty, env proměnné, limit uploadu, obsah nginx konfigurace a šablony), ne bajtů. Například řádek `client_max_body_size`, který do `nginx-default.conf` připisuje proxy `start.sh`, se nepočítá jako rozdíl.
- **Proxy není na serveru nastavená** (kontejner `mup-nginx-proxy` neexistuje): preflight skončí chybou s nápovědou `comet-deploy proxy setup`, ještě před buildem [moje volba]. MUP by aplikaci nasadil, ale nebyla by dostupná.

### 4.3 Nulový výpadek za proxy bez load balancingu [návrh, hlavní návrh §10.2]

Platí postup z hlavního návrhu §10.2 bod 4, včetně zálohy (bez nulového výpadku, pokud to s MUP šablonou spolehlivě nejde). Doplnění:

- **Pro které příkazy:** `deploy`, `reconfig`, `rollback` a `restart`, tedy všechny, které aplikační kontejner vytvářejí znovu [moje volba]. `start` a `stop` ne.
- **Kdy se použije:** proxy bez `loadBalancing` a zároveň `cometDeploy.zeroDowntime` není `false`. Druhý kontejner zároveň musí jít bezpečně spustit vedle prvního. Typicky to nejde, když `docker.args` publikuje porty na hostu nebo používá `--network host` / `--net=host`. Přesná pravidla určí builder. Když podmínky nejsou splněné, použije se běžná cesta přes `start.sh` a výstup jedním řádkem řekne proč.
- **Parametry nového kontejneru** musí být stejné, jaké by vytvořil `config/start.sh` na serveru. Po přejmenování je výsledek nerozlišitelný od kontejneru z `start.sh`. Jak toho builder dosáhne (např. spuštěním upravené kopie `start.sh` s jiným jménem a bez úvodního `docker rm -f`), je na něm. Výsledek musí ověřit testem proti `start.sh`.
- **Selhání:** pokud nový kontejner neprojde health checkem, odstraní se. Tagy a konfigurace se vrátí jako dnes (`revertServer`), ale **starý kontejner se nerestartuje**, protože celou dobu běží. Výsledek je `reverted` bez výpadku.
- **Zastavení starého kontejneru:** `docker stop -t 10` (výchozí hodnota Dockeru), pak `docker rm` [moje volba]. Starý se zastaví až poté, co je nový kontejner ve vygenerované nginx konfiguraci.
- **Známý kompromis [moje volba]:** docker-gen přidá nový kontejner do upstreamu hned po startu, ještě před health checkem. Během kontroly tak na něj může přijít část požadavků. Dokud Meteor neposlouchá, nginx požadavek pošle na starý kontejner. Pokud nová verze odpovídá chybou, uvidí ji krátce i část uživatelů. Builder to v dokumentaci uvede.

### 4.4 Vyřazení serveru z upstreamu při load balancingu [uživatel]

U `loadBalancing: true` publikuje aplikace port na hostu, takže dva kontejnery vedle sebe běžet nemohou. MUP nechává při restartu server v upstreamu (ref. §6.5) a rozpracované požadavky na něm selžou. comet-deploy:

1. Před restartem aplikace na serveru X přepíše na **všech proxy serverech** soubor `upstream/<app>` tak, aby byl X označený `down` (direktiva nginx, která zachová rozložení `ip_hash` pro ostatní servery). Pak spustí `docker exec mup-nginx-proxy nginx -s reload`. Soubor je zahrnutý přes `include`, takže reload na změnu obsahu stačí.
2. Počká, až doběhnou rozpracované požadavky: pevně **5 s** [moje volba].
3. Restartuje aplikaci na X (`start.sh`) a provede health check.
4. Po úspěchu vrátí na všech proxy serverech `upstream/<app>` do normálního tvaru, **byte po bytu shodného s výstupem MUP `upstream.sh`**, a znovu načte nginx.

Pravidla:
- **Pro které příkazy:** `deploy`, `reconfig`, `rollback` a `restart` [moje volba].
- **Nikdy nevyřadit všechny servery.** Krok, po kterém by v upstreamu nezůstal žádný server nahoře, proběhne bez vyřazování. Server, který už je označený `down`, se počítá jako „ne nahoře“. Týká se to strategie `parallel` a aplikace na jediném serveru. V canary se zbytek vyřazuje až po úspěchu canary serveru, takže canary zůstává nahoře.
- **Záznam o vyřazení je značka `down` přímo v `upstream/<app>`** [moje volba]. Žádný další soubor na serveru nevzniká. comet-deploy značku serveru odstraní **jen poté, co ten server projde health checkem** v `deploy`, `reconfig`, `rollback` nebo `restart`. Každý jiný přepis upstreamu značky zachová: §4.2, `setup`, `proxy setup` i deploy s `--servers`, který ten server nerestartuje. Vyřazený server, který je ve skutečnosti zdravý, se tedy vrátí příkazem `comet-deploy restart --servers <server>`. `status` a `proxy status` to u vyřazeného serveru napíšou.
- **Při selhání:**
  - `reverted`: server se po obnovení a úspěšném health checku vrátí do upstreamu.
  - `revert-failed`: server **zůstane vyřazený**, protože je rozbitý a posílat na něj provoz by škodilo. Souhrn to výrazně uvede [moje volba].
- **Ctrl+C:** stejně jako uvolnění zámku se na konci vrátí upstream do normálu, pokud server prošel health checkem.
- **Pád nebo výpadek spojení:** server zůstane vyřazený. Opraví to další `deploy`, `reconfig`, `rollback` nebo `restart`, který ten server restartuje a projde health checkem. `status` a `proxy status` vyřazené servery ukážou. Souhrn deploye na neobnovený upstream upozorní [uživatel]. Původně jsem uživateli řekl, že server vrátí i `proxy setup`. To je tímto pravidlem změněné [moje volba], aby `setup` nevrátil do provozu rozbitý server.
- `cometDeploy.zeroDowntime: false` vypne vyřazování i nulový výpadek z §4.3 a chování je jako v MUP [moje volba]. Nová volba se nezavádí.
- Které proxy servery se mění při `--servers`: všechny, jejichž upstream obsahuje restartovaný server, i když nejsou v `--servers` [moje volba].

### 4.5 Ostatní příkazy

| Příkaz | Chování |
|---|---|
| `proxy stop` | Jako MUP (`proxy-stop.sh`). |
| `proxy logs [opts]`, `proxy logs-le [opts]` | Jako MUP, včetně předání voleb `docker logs`. `logs-le` jako v MUP na serverech aplikace. |
| `proxy nginx-config` | Jako MUP. |
| `proxy status` | Jako MUP (oba kontejnery, expirace certifikátů přes `openssl x509 -enddate`). Navíc ukáže servery vyřazené z upstreamu a soubory pro aplikaci, které neodpovídají configu [moje volba]. |
| `status` | Na konci připojí `proxy status` (MUP hook `post.default.status`). |
| `reconfig` | U load balancingu obnoví konfigurační kontejner (MUP hook `post.reconfig`), navíc §4.2 až §4.4. |
| `proxy envconfig` | Srozumitelná chyba (§3). |

Příkazy běží přes `ctx.runner` s názvy příkazů jako v MUP (`proxy.setup`, `proxy.start`, …), aby se na ně v projektu hooks daly navěsit `pre`/`post` hooky.

### 4.6 Zámek [moje volba]

Zámek z hlavního návrhu (§11, `deploy.lock` na serverech aplikace) se rozšíří:
- **Load balancing:** `deploy`, `reconfig`, `rollback` a `restart` zamknou **všechny** servery aplikace, ne jen ty z `--servers`. Sdílejí totiž jeden upstream. Dva souběžné deploye různých podmnožin serverů by jinak mohly vyřadit oba servery.
- **`setup`, `proxy setup`, `proxy start`, `proxy stop` a `proxy reconfig-shared`** získají zámek aplikace na jejích serverech, aby nepřepsaly upstream uprostřed deploye. Pro proxy server bez aplikace (`proxy.servers` mimo servery aplikace) se zamykají servery aplikace.
- **Souběh s jinou aplikací na stejné proxy** (její `proxy start` nebo `reconfig-shared` během našeho přepnutí) se nezamyká. Nová proxy po vytvoření vygeneruje konfiguraci z běžících kontejnerů, takže přepnutí dál funguje. Dokumentace tento souběh uvede. Zámek na úrovni `/opt/mup-nginx-proxy` se nezavádí.

## 5. Testování (jen lokálně) [uživatel]

- **Unit:** každý vyrenderovaný soubor a skript proxy je stejný jako u MUP 1.5.11 (orákulum `test/oracle/mup-oracle.ts`). Pokryté jsou fixture configy `test/fixtures/configs/proxy-le` a `proxy-lb` a případy vlastních certifikátů, `nginxServerConfig`/`nginxLocationConfig`, `shared.*` a `stickySessions: false`.
- **Integrace na fake serverech:**
  - `proxy setup` z prázdného serveru, druhý `proxy setup` bez změn (proxy kontejnery se nerestartují), `proxy start` (restartují se).
  - Deploy za proxy, změna `clientUploadLimit` / přidání domény a následný deploy: změna se projeví ve vygenerovaném `default.conf` bez restartu proxy kontejnerů.
  - Let's Encrypt přes **Pebble**: companion získá certifikát, `proxy status` ukáže expiraci. Jak testovací doménu směrovat na fake server (např. `pebble-challtestsrv` jako DNS), určí builder. `shared.envLetsEncrypt.ACME_CA_URI` míří na Pebble.
  - Vlastní certifikát (vygenerovaný v testu) a jeho výměna při deployi.
  - **Nulový výpadek:** smyčka HTTP požadavků přes proxy během `deploy`, `reconfig`, `rollback` a `restart`: **žádný** neúspěšný požadavek (chyba spojení nebo status ≥ 500). Zvlášť test selhání health checku: starý kontejner běží dál bez výpadku.
  - **Load balancing na dvou fake serverech:**
    - Smyčka požadavků během deploye bez chyb, kromě požadavků, které nginx nemůže přesměrovat. Builder určí přesné kritérium a zdůvodní ho.
    - Přerušený deploy: server zůstane vyřazený, `status` to ukáže, `setup` ho nevrátí a vrátí ho až `restart --servers` nebo deploy toho serveru.
    - Vynechání vyřazování u `parallel` a u jednoho serveru.
    - Zapnutí a vypnutí `loadBalancing` a změna `PORT` bez výpadku podle pořadí v §4.2.
    - Souběžný `deploy --servers` dvou různých serverů: druhý narazí na zámek.
  - **Zaměnitelnost s MUP** (rozšíření `test/integration/interop.test.ts`): `mup proxy setup` + `mup deploy` → comet-deploy `deploy` → `mup deploy` a `mup proxy setup` → comet-deploy `deploy`. Pokaždé aplikace odpovídá přes proxy a soubory na serveru odpovídají MUP.
- **Docker 29:** k fake serveru (dnes Docker 27.5) přibude varianta s Dockerem 29.x a hlavní integrační test proxy běží i na ní (§6).

## 6. První úkol builderu: Docker 29 a staré proxy image [moje volba]

Docker Engine 29 zvedl minimální podporovanou verzi API na 1.44. Obě proxy image jsou několik let staré a s Dockerem komunikují přes docker-gen (a companion i jinak). Pokud používají napevno starší verzi API, na Dockeru 29 proxy nefunguje, a to ani s MUP. **Zatím je to neověřený odhad.**

Builder to ověří **jako úplně první krok**, ještě před prototypem nulového výpadku: na fake serveru s Dockerem 29.x spustí oba kontejnery přesně podle MUP `start.sh`, nasadí za ně kontejner s `VIRTUAL_HOST` a zkontroluje, že se vygeneruje upstream a companion vidí kontejnery.
- **Funguje:** pokračuje podle plánu a v dokumentaci uvede, že je ověřeno s Dockerem 29.
- **Nefunguje:** zastaví práci na proxy a přinese uživateli zjištění (co přesně selže) a možnosti, například novější image, `DOCKER_MIN_API_VERSION` na démonu nebo jen dokumentace. Rozhodne uživatel, protože každá možnost mění zaměnitelnost s MUP nebo server uživatele.

Hned potom následuje prototyp nulového výpadku (hlavní návrh §10.2), aby se o záloze rozhodlo brzy.

## 7. Dokumentace

Anglické `README.md` a `docs/*` (configuration, commands, how-it-works, migrating-from-mup, troubleshooting) popíšou:
- proxy a její příkazy,
- rozdíly proti MUP (§2 bod 4),
- kompromis z §4.3,
- co dělat se serverem, který zůstal vyřazený z upstreamu,
- výsledek ověření s Dockerem 29.

Zmínky „planned for phase 2“ u proxy zmizí. Dokumentace nesmí zmiňovat konkrétní aplikace, servery ani IP adresy uživatele.

## 8. Na builderovi

- Rozdělení kódu (např. `src/proxy/*`, `src/cli/commands/proxy.ts`) a jak sdílet existující `runOnServers`, `SshConnection.writeFile`/`putFile` a reporter.
- Jak rozpoznat změnu u §4.1 a §4.2, pokud neporuší stav na serveru.
- Spouštěč nového vygenerování nginx konfigurace bez restartu proxy (§4.2).
- Přesné podmínky, kdy nulový výpadek nejde (§4.3), a jak dosáhnout parametrů shodných se `start.sh`.
- Řazení kroků deploye (synchronizace proxy souborů, vyřazení z upstreamu, aktivace), pokud dodrží pravidla z §4.
- Testovací infrastruktura pro porty 80/443 a Pebble na fake serverech.

## 9. Kritéria úspěchu

1. Config s `proxy` (Let's Encrypt, vlastní certifikáty, load balancing, sdílené nastavení) projde `setup` a `deploy` na fake serverech a aplikace odpovídá přes proxy, u Let's Encrypt s certifikátem z Pebble.
2. Všechny vyrenderované soubory proxy jsou shodné s MUP 1.5.11 (unit testy s orákulem).
3. Testy zaměnitelnosti s MUP z §5 projdou.
4. Opakovaný `setup` / `proxy setup` beze změn proxy kontejnery nerestartuje, změna souborů pro aplikaci se projeví při `deploy` bez restartu proxy.
5. Deploy, reconfig, rollback a restart za proxy bez load balancingu: smyčka požadavků bez jediné chyby, nebo je zdokumentovaná záloha podle hlavního návrhu §10.2.
6. Load balancing: vyřazování podle §4.4 včetně přerušeného deploye a pravidla „nikdy všechny“.
7. Výsledek ověření s Dockerem 29 je zdokumentovaný (§6).
8. Lint, typecheck, build, unit, integrační a e2e testy jsou zelené.
