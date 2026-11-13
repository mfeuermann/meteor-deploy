# comet-deploy fáze 2, projekt 5: přenos image přes privátní Docker registry (`privateDockerRegistry`)

Stav: návrh, 2026-11-13. Navazuje na hlavní návrh `2026-11-07-comet-deploy-design.md` (§9 Přenos na servery, bod 1) a na projekt 4 (`transfer: 'stream'`). Od §9 hlavního návrhu se vědomě odchyluje, viz §4.1.

Uživatel rozhodnutí o návrhu nechal na mně, stejně jako u projektů proxy, mongo, hooks a stream. Moje volby jsou označené [moje volba].

## 1. Proč

Config MUP se sekcí `privateDockerRegistry` dnes comet-deploy odmítne (`"privateDockerRegistry" is not supported yet …`) a migrace z MUP pro takové aplikace končí. Kdo registry používá, má pro to obvykle důvod: servery se k jeho počítači nebo CI nedostanou jinak než přes registry, image chce mít uložený mimo servery, nebo deployuje na víc serverů a nechce image posílat z vlastního (pomalého) připojení na každý zvlášť.

Cíl je, aby config MUP s `privateDockerRegistry` fungoval v comet-deploy beze změny a aby comet-deploy a MUP mohly spravovat stejné servery i s registry, jako to umějí bez něj.

## 2. Cíle

1. **Config MUP s `privateDockerRegistry` (host, imagePrefix, username, password) funguje beze změny.** Image se lokálně postaví, pushne do registry a servery si ho z registry stáhnou.
2. **Registry je jen cesta přenosu.** Po distribuci má server přesně tag `mup-<lc app>:<verze>`, stejně jako po tunelu nebo `stream`. Aktivace, canary, automatický revert, `rollback` (i `--servers` a `--to`), `restart`, `reconfig`, historie, pročištění verzí, `status` a `destroy` fungují stejně jako bez registry a nepotřebují k registry přístup.
3. **Spolupráce s MUP i s registry:**
   - po úspěšném `deploy` ukazuje `<imagePrefix>/mup-<lc>:latest` v registry na nasazenou verzi, takže `mup reconfig` (start.sh MUP stahuje `:latest` z registry) spustí stejnou verzi;
   - po přechodu z MUP s registry funguje `comet-deploy rollback` zpět na verzi, kterou nasadil MUP, jako je to dnes bez registry: verze MUP je `:previous`. Platí to i tehdy, když se nástroje střídají (comet → MUP s registry → comet), viz §4.5. Automatická volba rollbacku se nemění: jako bez registry dá přednost starší verzi comet-deploy, pokud na serveru nějaká je.
4. **Selhání registry nikdy nezmění běžící aplikaci.** Přihlášení, push i pull jsou před aktivací; chyba zastaví deploy a žádný server se nezmění.
5. **Jasné chyby** pro tři místa, kde to v praxi selhává: přihlášení na počítači, push (oprávnění, dostupnost) a pull na serveru (server není přihlášený).

## 3. Necíle, anti-cíle, omezení

**Necíle:**
- Úklid v registry. Tagy verzí v registry zůstávají, comet-deploy je nikdy nemaže. Dokumentace řekne, že úklid je na uživateli (retention policy registry).
- `:previous` v registry. Ten používá jen vlastní deploy MUP; comet-deploy rollback dělá na serveru.
- Manifest list (víc architektur pod jedním tagem). Při víc platformách se pushne tag pro každou architekturu zvlášť a `:latest` se v registry nemění (§4.6).
- Nastavení důvěry k registry (TLS, `insecure-registries` v `daemon.json`) na počítači ani na serverech. Registry musí být pro lokální Docker i pro servery dostupné tak, jak je; dokumentace popíše, co nastavit.
- Přihlašování serverů k registry během deploye. Servery se přihlašují v `setup` / `docker setup` (MUP šablona `docker-setup.sh`, jako dnes); deploy při chybě oprávnění poradí tento příkaz [moje volba].
- Režim „jen pushni do registry“ bez distribuce na servery.
- MUP bundle mode (`kadirahq/meteord`): samostatný projekt.

**Anti-cíle (selhání, i kdyby to technicky fungovalo):**
- Server, který při startu nebo restartu aplikace sám stahuje `:latest` z registry. Verze, kterou server spustí, by pak záležela na stavu registry, ne na tom, co comet-deploy aktivoval (rozbitý canary, revert i rollback jednoho serveru).
- Heslo k registry v příkazové řádce na počítači (viditelné v `ps`), ve výstupu, v logu nebo v chybové hlášce.
- Push jinam než do registry z `host`, typicky do veřejného Docker Hubu, protože `imagePrefix` chybí nebo nezačíná hostem registry. Image obsahuje bundle aplikace.
- Rollback, který ohlásí úspěch, ale server dál běží na stejné verzi.
- `:latest` v registry ukazující na verzi, která se nenasadila úspěšně.
- Lokální tagy navíc, které zůstanou po deployi a zablokují úklid lokálních verzí.

**Omezení:**
- Na počítači stačí Docker CLI, které deploy už vyžaduje (`docker login --password-stdin`, `docker tag`, `docker push`). Žádný buildx `imagetools` ani `docker manifest` [moje volba: nefungují s registry bez TLS na `127.0.0.1`, kterou potřebují testy, a ani s `insecure-registries`].
- Na serveru stačí `sudo docker pull` (Docker 18+).

## 4. Chování

### 4.1 start.sh a jména image na serveru (odchylka od hlavního návrhu)

Hlavní návrh §9 počítal se start.sh od MUP beze změny, tedy se `sudo docker pull <prefix>/mup-<lc>:latest` při každém startu, a se sdíleným `:latest` v registry, které rozhoduje o verzi na všech serverech (`rollback --servers` by v registry módu nešel). To porušuje anti-cíl v §3 a cíl 2.

Místo toho [moje volba]:
- **start.sh se s registry renderuje přesně jako bez registry:** `imagePrefix` je `mup-` a `privateRegistry` se šabloně nepředá. start.sh tedy spustí lokální `mup-<lc>:latest` jako dnes, nic nestahuje a neprovádí `docker image prune`.
- **meteor-start.sh** dostává `privateRegistry` dál jako MUP. Nic to nemění, protože `mup-<lc>:latest` na serveru existuje.
- **docker-setup.sh** (`setup`, `docker setup`) dostává `privateRegistry`, jen když config má `username` i `password`. Pak na serverech provede `docker login` jako MUP. Bez nich se přihlášení vynechá: šablona MUP by spustila `docker login` s prázdnými údaji a `setup` by pod `set -e` selhal [moje volba]. Šablona sama se nemění.
- **Jména na serveru zůstávají bez prefixu:** `mup-<lc>:<verze>`, `:latest`, `:previous`. `localImageRepo` se nemění, stejně jako lokální tagy buildu a build cache.
- Rozdíl oproti MUP (jiný start.sh při registry) se zdokumentuje v migration guide a v how-it-works. Unit test, který porovnává start.sh s MUP, pro config s registry očekává start.sh MUP renderovaný bez registry.
- Hlavní návrh dostane v §9 bodu 1 poznámku s odkazem na tento dokument.

### 4.2 Volba přenosu a validace

| `privateDockerRegistry` | `cometDeploy.transfer` | Výsledek |
|---|---|---|
| ano | `auto` (výchozí) nebo `registry` | registry pro všechny servery |
| ano | `tunnel` nebo `stream` | chyba configu |
| ne | `registry` | chyba configu |
| ne | `auto`, `tunnel`, `stream` | jako dnes |

- **Chyby configu** hlásí validace configu (všechny příkazy, i `comet-deploy validate`) [moje volba]:
  - `cometDeploy.transfer "tunnel" cannot be used with privateDockerRegistry: with a private registry the image goes through the registry. Remove cometDeploy.transfer or set it to "registry".` (obdobně pro `stream`);
  - `cometDeploy.transfer "registry" needs a privateDockerRegistry section (host, imagePrefix, username, password).`
  - `privateDockerRegistry.username and password go together: set both, or neither and log in to the registry yourself.` (jen jedno z nich by v MUP i tady vedlo k přihlášení s prázdným údajem).
- **`imagePrefix` kontrolují příkazy, které pushují** (`deploy`, `meteor deploy`, `meteor push`), před preflightem. Ve validaci ne, protože MUP config bez něj přijme a `setup`, `reconfig` ani `rollback` ho nepotřebují [moje volba].
  - Chybí: `privateDockerRegistry.imagePrefix is required: it is where comet-deploy pushes the image, for example "registry.example.com/myteam".`
  - Musí mířit do registry z `host` [moje volba]:
    - registry z `imagePrefix` je jeho první část, pokud obsahuje `.` nebo `:` nebo je `localhost`, jinak `docker.io` (tak jméno image čte Docker);
    - registry z `host` je `host` bez schématu (`https://`) a bez cesty (`/v1/`); `index.docker.io` a `registry-1.docker.io` znamenají `docker.io`;
    - porovnání bez ohledu na velikost písmen, port se počítá;
    - když se liší: `privateDockerRegistry.imagePrefix "myteam" would push to docker.io, not to the registry "registry.example.com" in privateDockerRegistry.host. Start it with the registry host, for example "registry.example.com/myteam".`
    - Uživatel Docker Hubu (`host: 'docker.io'` nebo `'https://index.docker.io/v1/'`, `imagePrefix: '<user>'`) projde.
- `assertPhase1Supported` už nic neodmítá a zmizí, nebo se nahradí kontrolou `imagePrefix`.
- V registry módu preflight nezkouší forwarding a lokální registry (`comet-deploy-registry`) se nespouští.

### 4.3 Přihlášení a push na počítači

1. **Přihlášení**, jen když config má `username` i `password`: `docker login --username <u> --password-stdin <host>`, heslo jde na stdin. Proběhne po preflightu a před buildem, aby chybné heslo neprošlo až po minutách buildu [moje volba]. Bez `username`/`password` se přihlášení přeskočí a použije se to, co lokální Docker už má (např. `docker/login-action` v CI).
   - Vedlejší efekt, který dokumentace zmíní: Docker si přihlášení uloží (`~/.docker/config.json` nebo úložiště hesel systému) a přepíše tím případné dřívější přihlášení ke stejnému hostu.
2. **Push**, ve fázi Distribute, jednou za platformu:
   - jedna platforma: `<imagePrefix>/mup-<lc>:<verze>`;
   - víc platforem: `<imagePrefix>/mup-<lc>:<verze>-<arch>` (stejná přípona jako lokální tag);
   - postup: `docker tag <lokální tag> <ref>`, `docker push <ref>`, pak se lokální tag `<ref>` odstraní (jen tag, image zůstane pod lokálním tagem verze);
   - info řádek s dobou pushe (`registry: pushed registry.example.com/team/mup-myapp:<verze> in 14s`), s `--verbose` výstup `docker push`.
3. Pak `checkAbort` jako u ostatních přenosů a teprve potom servery.

### 4.4 Na každém serveru, paralelně

1. **Má už tuto verzi?** `mup-<lc>:<verze>` existuje → přeskočit (`ok (already on the server)`).
2. **Jinak:** `sudo docker pull <ref>`, `sudo docker tag <ref> mup-<lc>:<verze>`, `sudo docker rmi <ref>` (jen tag) a kontrola, že `mup-<lc>:<verze>` existuje.
3. Řádek serveru: `distribute running`, na konci `ok <čas> (from <host>)`. S `--verbose` výstup `docker pull`.

### 4.5 Server, na kterém naposledy pracoval MUP s registry

`mup deploy` a `mup reconfig` s registry zapíšou na server start.sh MUP, který při každém startu stahuje `<imagePrefix>/mup-<lc>:latest` z registry a spouští prefixovaný image. Lokální `mup-<lc>:latest` pak neodpovídá tomu, co běží: chybí (první přechod z MUP), nebo je to starší verze z dřívějšího deploye comet-deploy (nástroje se střídají).

- **Poznání:** start.sh na serveru obsahuje registry blok MUP, tj. řádek `sudo docker pull $IMAGE` [moje volba]. start.sh od comet-deploy ho nikdy nemá (§4.1).
- **Převzetí** (`deploy`, `meteor deploy`, `reconfig`): na takovém serveru se na začátku aktivace (před snímkem configu a přetagováním) otaguje `mup-<lc>:latest` na image, ze kterého běží (nebo naposledy běžel) kontejner aplikace (`docker inspect` kontejneru → ID image → `docker tag`). Aktivace pak udělá z verze MUP `:previous`, takže `rollback` na ni funguje. Bez kontejneru aplikace se nic nepřebírá. Běžící aplikace se nezmění a prefixované tagy MUP se nemažou. Oba příkazy pak zapíšou start.sh od comet-deploy, takže server je zase ve stavu comet-deploy. Platí i bez `privateDockerRegistry` v configu (uživatel registry z configu odebral), protože se pozná podle start.sh [moje volba].
- **`rollback`** na takovém serveru skončí chybou dřív, než ho změní, stejně jako server bez verze, na kterou by se dalo vrátit (strategie pak další servery přeskočí) [moje volba]: start.sh by spustil `:latest` z registry, ne verzi, na kterou rollback přepnul. `Server "one" was last deployed by MUP with privateDockerRegistry: its start.sh pulls :latest from the registry, so a rollback would not change the version. Run "comet-deploy reconfig" first, then the rollback.`
- **`restart`, `start`, `stop`** pracují se start.sh, který na serveru je, jako MUP (restart s ním stáhne `:latest` z registry). Dokumentace to zmíní.
- **Revert** po neúspěšném deployi nebo reconfigu vrátí start.sh MUP a ten stáhne `:latest` z registry. To je pořád verze MUP, protože comet-deploy `:latest` v registry mění jen po úspěšném deployi (§4.6).

### 4.6 `:latest` v registry po deployi

Po `deploy` (a `meteor deploy`), který skončil úspěšně na všech serverech, se `<imagePrefix>/mup-<lc>:latest` v registry nastaví na nasazenou verzi: `docker tag`, `docker push`, odstranění lokálního tagu. Jen pro MUP (cíl 3), comet-deploy sám tento tag nikdy nečte.

- **Přeskočí se**, s info řádkem proč:
  - deploy nebyl úspěšný na všech serverech, nebo skončil revertem;
  - deploy na podmnožinu serverů (`--servers`): `:latest` by `mup reconfig` přenesl i na servery, které novou verzi nemají [moje volba];
  - víc platforem (žádný manifest list, §3).
- **Selhání pushe `:latest`** je jen varování; deploy zůstane úspěšný. Text řekne, že na tom záleží jen pro MUP (`mup reconfig` by spustil starší verzi).
- `meteor push`, `rollback`, `reconfig` a `restart` registry nemění. Dokumentace řekne, že po `rollback` ukazuje `:latest` v registry dál na novější verzi.
- Dva souběžné deploye stejné aplikace na různé podmnožiny serverů se o `:latest` nepřou, protože podmnožina ho nenastavuje.

### 4.7 Chyby

Všechny jsou `CometError` a žádná nevypíše heslo.
- **Přihlášení:** `Logging in to the registry "<host>" failed: <stderr>` s radou `Check privateDockerRegistry.username and password. Nothing was built or pushed, and no server was changed.`
- **Push:** `Pushing <ref> to the registry failed: <stderr>`. Rada podle výstupu:
  - oprávnění (`denied`, `unauthorized`, `authentication required`): `Check that the registry account may push to "<imagePrefix>".` (bez credentials v configu: `… or log in first with "docker login <host>".`);
  - jinak: `Check that this computer can reach the registry "<host>".`;
  - vždy s `No server was changed.`
- **Pull na serveru:** chyba distribuce toho serveru v souhrnné `Image distribution failed: …` (rada `No server was changed.` zůstává). Při chybě oprávnění obsahuje zpráva serveru radu:
  - s `username`/`password` v configu: `The server is not logged in to the registry: run "comet-deploy docker setup", which runs docker login on the servers.`;
  - bez nich: `The server is not logged in to the registry: run "sudo docker login <host>" on the server, or set privateDockerRegistry.username and password and run "comet-deploy docker setup".`
- **Ctrl+C** jako u ostatních přenosů: fáze Distribute doběhne, deploy skončí kódem 130, zámky se uvolní.

### 4.8 Kde se to uplatní

`deploy`, `meteor deploy`, `meteor push` (i s `--cached-build` a v CI). `meteor build` nic nepushuje. Hooky se nemění: `meteor.prepareBundle` je distribuce.

## 5. Kód

- **`src/transfer/registry.ts`** (nový): lokální přihlášení, push verze (tag, push, odstranění tagu), pull na serveru (pull, otagování, kontrola), push `:latest`.
- **`src/remote/ops.ts`, `src/deploy/activate.ts`:** poznání start.sh MUP s registry a převzetí podle §4.5 na začátku aktivace (`deploy`, `reconfig`). Rozpoznání chyby oprávnění pro rady v §4.7.
- **`src/deploy/distribution.ts`:** registry mód jako třetí cesta vedle tunelu a `stream`; funkce přes `DistributionDeps`, aby šly v unit testech nahradit.
- **`src/deploy/pipeline.ts`:** kontrola `imagePrefix`, přihlášení po preflightu a před buildem, odmítnutí `rollback` podle §4.5, `:latest` po úspěšném deployi podle §4.6.
- **`src/deploy/preflight.ts`:** v registry módu žádná zkouška forwardingu.
- **`src/config/validate.ts`:** chyby configu z §4.2.
- **`src/cli/commands/setup.ts`, `docker.ts`:** `privateRegistry` pro docker-setup.sh jen s credentials (§4.1).
- **`src/remote/app-files.ts`:** start.sh podle §4.1.
- **`src/output/secrets.ts`:** heslo se už maskuje; ověřit, že se maskuje i v chybách `docker login` a `docker push`.

## 6. Testy

- **Unit:**
  - tabulka §4.2 včetně textů chyb; `username` bez `password` a naopak; kontrola `imagePrefix` jen u příkazů, které pushují, včetně porovnání s `host` (chybějící host v prefixu, jiný host, jiný port, Docker Hub `docker.io` / `https://index.docker.io/v1/` s `imagePrefix: '<user>'`);
  - docker-setup.sh: s credentials obsahuje `docker login`, bez nich ne;
  - převzetí po MUP: start.sh s `sudo docker pull $IMAGE` → `mup-<lc>:latest` na image kontejneru (i když `mup-<lc>:latest` už existuje a ukazuje jinam); start.sh od comet-deploy → nic; bez kontejneru → nic; v `deploy` i `reconfig`;
  - `rollback` na serveru se start.sh MUP s registry skončí chybou a nic nezmění;
  - start.sh s registry je shodný se start.sh MUP bez registry; meteor-start.sh dál dostává `privateRegistry`;
  - přihlášení: heslo jen na stdin, nikdy v argumentech; bez credentials se přeskočí;
  - push: refy pro jednu a víc platforem, odstranění lokálního tagu i po chybě pushe, rady podle chyby;
  - pull proti falešnému spojení: převzetí z MUP, přeskočení, otagování a odstranění tagu, chyba oprávnění s radou `docker setup`;
  - `:latest`: nastaví se po úspěchu na všech serverech; přeskočí se při chybě, revertu, `--servers` a víc platformách; selhání je jen varování;
  - v registry módu se nespouští lokální registry ani zkouška forwardingu.
- **Integrace:**
  - Testovací registry `registry:2.8.3` s htpasswd, publikovaná na `127.0.0.1:<port>` lokálního Dockeru (Docker bere `127.0.0.0/8` jako insecure, takže TLS není nutné). Falešné servery na stejné adrese `127.0.0.1:<port>` dosáhnou registry přes přeposílání uvnitř kontejneru (např. `socat` v image falešného serveru, se zvýšením verze image).
  - Testy nesmějí změnit `~/.docker/config.json` vývojáře: `DOCKER_CONFIG` do dočasného adresáře. Pozor: s ním se ztratí aktuální docker context (zde OrbStack; nastavit `DOCKER_HOST`) a CLI pluginy z `~/.docker/cli-plugins` (buildx; symlink).
  - Deploy ukázkové aplikace přes registry na dva servery přihlášené přes `comet-deploy docker setup`: oba běží novou verzi, na serverech je jen `mup-<lc>:<verze>`/`:latest`/`:previous` (žádný prefixovaný tag), v registry je verze i `:latest`; druhý deploy a `rollback --servers` jednoho serveru fungují.
  - Server bez přihlášení: chyba distribuce s radou `docker setup`, nic se nezměnilo.
  - Interop s MUP 1.5.11: (a) comet `deploy` přes registry, pak `mup reconfig` → běží stejná verze; (b) `mup setup` + `mup deploy` s registry, pak comet `deploy` a `rollback` → běží verze MUP; (c) střídání: comet `deploy`, `mup reconfig`, comet `rollback` → chyba bez změny, comet `reconfig` a `rollback` → běží verze MUP; pak `mup deploy` s registry a comet `deploy` → `:previous` je nová verze MUP.

Akceptace na reálném serveru do „hotovo“ nepatří [moje volba]; žádný z reálných serverů uživatele registry nepoužívá.

## 7. Dokumentace

- configuration.md: sekce `privateDockerRegistry` (klíče, povinný `imagePrefix`, kdy se přihlašuje, co se pushuje, úklid registry), tabulka `transfer` (§4.2), odstranit řádky phase 2.
- how-it-works.md: fáze Distribute v registry módu, start.sh bez pullu, `:latest` v registry.
- migrating-from-mup.md: řádek `privateDockerRegistry`, rozdíl start.sh, převzetí z MUP a rollback na verzi MUP, střídání nástrojů (§4.5), tabulka podpory.
- troubleshooting.md: přihlášení selhalo, push `denied`, pull `unauthorized` → `docker setup`, registry bez důvěryhodného certifikátu (`x509`, `insecure-registries`).
- commands.md: krok Distribute u `deploy`; `docker setup` přihlašuje servery k registry.
- ci.md: registry v CI (credentials v configu nebo přihlášení předem).
- README: stav, omezení, roadmapa.

## 8. Co je na implementátorovi

- Rozdělení kódu mezi `registry.ts`, `distribution.ts` a pipeline, pokud zůstane testovatelné přes závislosti.
- Přesné znění info řádků v rámci §4.3 až §4.6.
- Jak falešné servery dosáhnou testovací registry, pokud ref na počítači i na serveru zůstane stejný.
- Zda testovací registry potřebuje TLS (htpasswd přes HTTP funguje-li, TLS netřeba).
