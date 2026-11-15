# comet-deploy fáze 2, projekt 6: bundle mode MUP

Stav: návrh, 2026-11-15. Navazuje na hlavní návrh `2026-11-07-comet-deploy-design.md` (build image, §5) a na projekt 5 (registry), ze kterého přebírá vzor převzetí serveru po MUP (§4.5 tam).

Uživatel rozhodnutí o návrhu nechal na mně, stejně jako u projektů proxy, mongo, hooks, stream a registry. Moje volby jsou označené [moje volba].

Builder check (2026-11-15) otevřel čtyři otázky, všechny jsem rozhodl sám:
1. převzatá verze MUP dostane navíc tag `:mup-bundle` (§4.5);
2. převzetí běží i v `restart`, takže za proxy nikdy dva kontejnery nesdílejí `current`, a `zd-finish.sh` maže `current` jen tehdy, když ho nový kontejner nemountuje (§4.4);
3. převzetí běží i v `rollback` (§4.5);
4. +12 s pro health check se řídí labelem image `comet-deploy.bundle=1`, ne configem (§4.4).

## 1. Proč

Bundle mode je poslední část configu MUP, kterou comet-deploy odmítá: `The docker image "kadirahq/meteord" cannot build an app image (MUP bundle mode). Bundle mode is planned for phase 2 of comet-deploy.`

MUP používá bundle mode, když `prepareBundleSupported` vrátí false. To nastane ve dvou případech:
- `docker.prepareBundle: false`;
- bez `docker.prepareBundle` a s image, který nezačíná `abernix/meteord` ani `zodern/meteor`. Sem patří i výchozí `kadirahq/meteord`, takže bundle mode dostane každý config bez `docker.image`.

V bundle mode MUP:
- nahraje `bundle.tar.gz` na server do `/opt/<app>/tmp/`;
- `meteor-start.sh` ho při deployi zkopíruje do `/opt/<app>/current/` (a předtím smaže `mup-<app>:latest` i `:previous`);
- `start.sh` spustí samotný základní image (`docker.image`) s `--volume=/opt/<app>/current:/bundle`.

Kontejner pak při každém startu bundle rozbalí, nainstaluje npm závislosti a spustí `node main.js`. Tak to dělají `kadirahq/meteord`, `abernix/meteord` i `zodern/meteor`; je to smlouva bundle mode.

Cíl je, aby takový config fungoval v comet-deploy beze změny a aby comet-deploy a MUP mohly spravovat stejné servery i v bundle mode.

## 2. Cíle

1. **Config v bundle mode projde** `deploy`, `meteor deploy`, `meteor push`, `meteor build`, `reconfig`, `restart` a `rollback` beze změny. Kontejner na serveru dělá totéž co v MUP: najde `/bundle/bundle.tar.gz`, rozbalí ho, nainstaluje npm závislosti a spustí aplikaci.
2. **Verze zůstávají image.** Pro comet-deploy je bundle mode jen jiný způsob, jak vyrobit image `mup-<app>:<verze>`. Distribuce (tunel, stream, registry), canary, revert, `rollback`, historie, pročištění a `status` fungují beze změny.
3. **Střídání s MUP funguje oběma směry:**
   - po `mup deploy` v bundle mode jde `comet-deploy deploy` a pak `comet-deploy rollback` zpět na verzi MUP;
   - po `comet-deploy deploy` spustí `mup reconfig` verzi z comet-deploy;
   - další `mup deploy` v bundle mode funguje jako dřív.
4. **Žádný build uvnitř image.** Image vznikne bez spouštění čehokoli z base image, takže build nepotřebuje emulaci jiné architektury, buildx ani síť (kromě případného pullu base image).

## 3. Necíle, anti-cíle, omezení

**Necíle:**
- Rychlejší start v bundle mode. npm závislosti se instalují při každém startu kontejneru, stejně jako v MUP. Kdo chce cache npm vrstvy, nastaví `docker.prepareBundle: true` nebo použije `zodern/meteor`; to už comet-deploy umí.
- Přenos jen změněných vrstev uvnitř bundlu. Bundle je jedna vrstva a s každou verzí putuje celý, jako u SFTP uploadu v MUP.
- Opravit image, které v bundle mode nefungují ani v MUP. Příklad: non-root `zodern/meteor` (ověřeno spikem 2026-11-15: `tar: bundle/programs: Cannot mkdir` s mountem jako v MUP i s image z comet-deploy). Comet-deploy jen varuje (§4.6).
- Spustit skutečnou aplikaci na `kadirahq/meteord` v testech. Má Node 0.10, na kterém dnešní Meteor neběží, a na arm64 Macu pod emulací padá už `npm`.
- `BUNDLE_URL` a další proměnné image, které MUP nepoužívá.

**Anti-cíle (selhání, i kdyby to technicky fungovalo):**
- Aplikace běží jinak než v MUP: závislosti se instalují při buildu, běží jiný Node nebo jiný uživatel, nebo jsou jinak nastavená práva na `/bundle`.
- Build spustí ONBUILD instrukce base image. `kadirahq/meteord:latest` má `ONBUILD COPY ./ /app` a `ONBUILD RUN bash $METEORD_DIR/on_build.sh`, které by se pokusily postavit Meteor ze zdrojáků.
- Server po comet-deploy, na kterém `mup deploy`, `mup reconfig` nebo `mup restart` nefunguje.
- Po prvním deployi z comet-deploy na server MUP v bundle mode nejde verze MUP vrátit (revert, `rollback`).
- Změna chování configů, které bundle mode nepoužívají (prepare mode se `zodern/meteor` apod.).

**Omezení:**
- Image vznikne z base image pro danou platformu. `kadirahq/meteord` existuje jen pro `linux/amd64`, takže arm64 server s ním nefunguje (v MUP také ne, tam končí `exec format error`).
- Na serverech beze změny: Docker 18+, `sudo`, `bash`, `tar` (MUP ho na serveru také používá).

## 4. Chování

### 4.1 Kdy je bundle mode

Bundle mode nastane přesně tehdy, když `prepareBundleSupported(app.docker)` (src/build/index.ts, pravidlo MUP) vrátí false. Nic jiného ho nezapíná.

### 4.2 Image s bundlem [moje volba]

`mup-<app>:<verze>` (s více platformami `…-<arch>`) obsahuje base image `docker.image` beze změny konfigurace a k tomu jednu vrstvu:

| Cesta v image | Vlastník | Práva | Proč |
|---|---|---|---|
| `/bundle/` | `root:root` | `755` | jako `sudo mkdir current` v `meteor-start.sh` |
| `/bundle/bundle.tar.gz` | `root:root` | `644` | jako `sudo cp tmp/bundle.tar.gz current/` |

Pokud base image `/bundle` už má (například `zodern/meteor:root` ho má jako `app:app 700`), výsledek musí být přesto `root:root 755`, protože mount v MUP adresář image překryje. Žádný jiný soubor se nemění.

- **Vznik bez Dockerfile:**
  1. `docker create --platform <platforma> <docker.image>` vytvoří kontejner, který se nikdy nespustí;
  2. `docker cp - <kontejner>:/` do něj zapíše proud tar se dvěma položkami z tabulky (vlastník a práva jsou v hlavičkách tar);
  3. `docker commit` s `--change 'LABEL comet-deploy.version=<verze>'` a `--change 'LABEL comet-deploy.bundle=1'` vytvoří image. Label `comet-deploy.bundle` říká health checku, že kontejner při startu instaluje bundle (§4.4);
  4. dočasný kontejner se vždy smaže, i po chybě.

  Proč takhle: ONBUILD se nespustí, nic neběží (bez emulace), konfigurace base image (ENTRYPOINT, ENV, USER, WORKDIR, EXPOSE) zůstane. Spike 2026-11-15 to ověřil se `zodern/meteor:root` (aplikace odpověděla) i s `kadirahq/meteord`.
- **`bundle.tar.gz` vznikne jako v MUP:** knihovna `tar` (node-tar, kterou používá MUP) s volbami `portable: true` a `gzip: { level: 9 }`, s `cwd` v build location a s položkou `bundle`. Soubor leží v build location vedle `bundle/`. `tar` přibude do `dependencies` [moje volba]: systémový `tar` se mezi macOS a Linuxem liší (xattrs, vlastník).
- **Žádný buildx, žádný `--build-arg`, žádný `NODE_VERSION`.** Verzi Node bundlu comet-deploy přečte, pokud to jde (pro historii a cache). Když chybí, bundle mode neselže [moje volba].

### 4.3 Build

- **`meteor build`** se spustí stejně jako dnes (`--directory`, `--architecture` podle platformy, `serverOnly`).
- **Base image se pullne** jako dnes, chyba pullu se ignoruje. Když base image pro platformu lokálně chybí (pull selhal nebo varianta neexistuje), `docker create` selže a build skončí chybou:
  ```
  The docker image "kadirahq/meteord" is not available for linux/arm64: <stderr docker create>
  Hint: In bundle mode the servers run this image itself. Use an image that exists for linux/arm64 ("docker buildx imagetools inspect kadirahq/meteord" lists its platforms).
  ```
  [Změněno při review: `zodern/meteor:root` i `:latest` existují jen pro `linux/amd64`, takže rada „or a zodern/meteor image“ na arm64 nepomůže.]
- **Base image nesmí mít `/bundle` (ani `/`) jako VOLUME** [doplněno při review]: `docker create` pro něj udělá anonymní volume, `docker cp` zapíše do něj a `docker commit` ho vynechá, takže by image neměl bundle. Před `docker create` se proto přečte `docker image inspect --format '{{json .Config.Volumes}}'` a build skončí chybou:
  ```
  The docker image "<image>" declares /bundle as a volume, so the bundle cannot be part of the app image: docker commit leaves volumes out.
  Hint: Use a base image without that VOLUME, or an image that can build an app image (zodern/meteor, docker.prepareBundle: true).
  ```
  Převzetí serveru MUP (`bundle-adopt.sh`) se stejným image skončí chybou dřív, než cokoli změní.
- **Hash vstupů** obsahuje i režim (`bundle`) a verzi formátu image s bundlem (`BUNDLE_IMAGE_VERSION = 1`), takže se image z prepare mode a z bundle mode v cache nikdy nezamění [moje volba]. Při nezměněných vstupech se image použije znovu jako dnes (`No changes since …`).
- **Informační řádek** při buildu: `bundle mode: mup-myapp:<verze> is "kadirahq/meteord" with the bundle in /bundle; the app installs its npm dependencies each time the container starts.`
- **`--cache-from` / `--cache-to`** v bundle mode nemají co dělat. Varování: `--cache-from and --cache-to are ignored in bundle mode: the app image is not built with BuildKit.` [moje volba]
- **`docker.buildInstructions`** se v bundle mode nepoužijí, jako v MUP (ten je aplikuje jen při prepare bundle). Viz varování v §4.6.

### 4.4 Na serveru

- **start.sh i env.list zůstávají beze změny.** Je to šablona MUP, kterou comet-deploy už renderuje. Protože `mup-<app>:latest` existuje, `start.sh` spustí image bez volume (`VOLUME=""`) a kontejner najde `/bundle/bundle.tar.gz` v image.
- **`meteor-start.sh` se renderuje s `removeImage: false`** jako dnes; comet-deploy nikdy nemaže `:latest`.
- **Zero-downtime za proxy:** `zd-start.sh` dnes maže `/opt/<app>/current` hned na začátku. Starý kontejner MUP v bundle mode ale z tohoto adresáře běží (mount `/bundle`) a obsluhuje z něj i statické soubory klienta. Proto [moje volba]:
  - `current` se smaže až v `zd-finish.sh`, a to teprve po odstranění starého kontejneru, a jen když nový kontejner `current` nemountuje;
  - když přepnutí selže, `current` zůstane, takže starý kontejner běží dál se svými soubory a jeho restart (`--restart=always`) dál funguje;
  - v image mode se `current` nepoužívá, takže pozdější smazání nic nemění.

  Díky převzetí (§4.5) nový kontejner vždy startuje z image, takže dva kontejnery nikdy nerozbalují bundle do stejného `current`.
- **Health check čeká o 12 s déle, když startující kontejner má label `comet-deploy.bundle=1`** (`deployCheckWaitTime + 12`) [moje volba]:
  - rozhoduje image, ne config. Zjistí se na serveru z labelu kontejneru, který health check sleduje, takže to platí i pro revert nebo rollback na image s bundlem po přechodu configu do prepare mode a pro převzatou verzi MUP;
  - platí ve všech příkazech, které health check spouštějí;
  - důvod: `start.sh` MUP po spuštění s volume čeká 15 s, s image jen 3 s, takže s image z comet-deploy by aplikace měla na start o 12 s méně než v MUP. Instalace npm závislostí při startu (u `zodern/meteor` i stažení Node) ten čas potřebuje;
  - kontejner MUP s mountem `/bundle` (start bez převzetí) label nemá a nepotřebuje ho, protože tam čeká sám `start.sh`.

### 4.5 Server, na kterém naposledy pracoval MUP v bundle mode

Po `mup deploy` v bundle mode na serveru chybí `mup-<app>:latest` i `:previous`. `meteor-start.sh` je smazal. Kontejner aplikace běží ze základního image s mountem `/opt/<app>/current:/bundle` a verze MUP je jen soubor `current/bundle.tar.gz`.

- **Poznání:** kontejner aplikace má mount s cílem `/bundle` a zdrojem `/opt/<app>/current`, a `/opt/<app>/current/bundle.tar.gz` existuje.
- **Převzetí na začátku každé aktivace a každého restartu** (`deploy`, `meteor deploy`, `reconfig`, `rollback`, `restart`), před snímkem configu a přetagováním [moje volba]. Postup:
  1. na serveru `docker create` z ID image, ze kterého běží kontejner aplikace;
  2. `docker cp -` s proudem tar, který obsahuje `bundle/` (root, 755) a kopii `current/bundle.tar.gz` (root, 644), sestavený pod `sudo` v dočasném adresáři v `/opt/<app>/tmp/`;
  3. `docker commit` s labelem `comet-deploy.bundle=1` na `mup-<app>:latest` a zároveň na `mup-<app>:mup-bundle`;
  4. dočasný kontejner a adresář se smažou;
  5. image, který měl `:mup-bundle` předtím, se smaže, pokud teď nemá žádný tag a žádný kontejner ho nepoužívá (`docker rmi` bez `-f`, chyba se ignoruje).

  Aktivace pak udělá z verze MUP `:previous`, takže revert i `rollback` na ni fungují. Běžící aplikace se nezmění. Bez takového kontejneru se nic nepřebírá.
  - **Proč i `rollback` a `restart`:**
    - bez převzetí by `rollback` neměl `:latest`, na který by se při neúspěchu vrátil, a `meteor-start.sh` by smazal `current`, tedy jedinou kopii verze MUP;
    - `restart` za proxy by spustil druhý kontejner se stejným mountem `current`, takže dva kontejnery by rozbalovaly a instalovaly do jednoho adresáře.
  - **Proč `:mup-bundle`:** `mup deploy` v bundle mode spouští `docker rmi mup-<app>:latest || true`. Docker odmítne smazat poslední tag image, ze kterého běží kontejner, a MUP by pak tiše dál spouštěl starou převzatou verzi. Tag `:mup-bundle` drží převzatou verzi MUP mimo verze comet-deploy (`VERSION_RE` ho nezná), takže se neobjeví v `status`, v `history` ani mezi kandidáty `rollback`. `meteor destroy --force` ho smaže spolu s tagy verzí. Na serveru je vždy nejvýš jeden.
  - Platí bez ohledu na to, zda je config v bundle mode, protože se pozná podle kontejneru [moje volba].
  - Verbose řádek: `took over the bundle MUP runs as :latest`.
- **`rollback`** po převzetí přetaguje `:latest` na zvolenou verzi a `start.sh` spustí image. Automatická volba je jako dnes: když běžící verze není verze comet-deploy (MUP deployoval mezitím), vybere nejnovější ponechanou verzi comet-deploy. Když server nemá žádnou verzi z comet-deploy, použije `:previous`; když nemá ani ten, skončí jako dnes `Nothing to roll back to …`.
- **`start` a `stop`** se nemění. Po `stop` kontejner neexistuje, takže není co převzít, a `start.sh` použije bundle z `current`, stejně jako v MUP.
- **`mup deploy` po comet-deploy** smaže tag `:latest` (image zůstane pod tagem verze nebo pod `:mup-bundle`), vytvoří `current` z nahraného bundlu a spustí base image s volume, jak je v MUP běžné. **`mup reconfig` a `mup restart` po comet-deploy** spustí `mup-<app>:latest`, tedy verzi z comet-deploy.

### 4.6 Validace a varování

Tato varování hlásí `validate` i příkazy, které načtou config:

- bundle mode s neprázdnými `docker.buildInstructions`:
  ```
  app.docker.buildInstructions are ignored in bundle mode, as in MUP: the base image "kadirahq/meteord" runs the bundle as it is. Set docker.prepareBundle: true (or use a zodern/meteor image) to apply them.
  ```
- bundle mode s `zodern/meteor`, jehož tag neobsahuje `root` (tag chybí, `latest`, `slim` …):
  ```
  app.docker.image "zodern/meteor:latest" cannot unpack the bundle in bundle mode: its app user cannot write to /bundle, with MUP as with comet-deploy. Use "zodern/meteor:root", or remove docker.prepareBundle: false.
  ```

Chyba `cannot build an app image (MUP bundle mode)` zmizí.

### 4.7 Preflight

V bundle mode se lokálně nekontroluje buildx ani to, zda builder umí cílové platformy. Image nevzniká přes buildx a nic se v něm nespouští. Ostatní lokální kontroly zůstávají: Docker běží a příkaz `meteor` funguje.

### 4.8 Kde se to uplatní

| Příkaz | Bundle mode |
|---|---|
| `deploy`, `meteor deploy` | build podle §4.2–4.3, převzetí podle §4.5 |
| `meteor push`, `meteor build` | build podle §4.2–4.3 |
| `reconfig`, `restart`, `rollback` | převzetí podle §4.5 |
| všechny příkazy s health checkem | +12 s pro image s labelem `comet-deploy.bundle=1` (§4.4) |
| `meteor destroy --force` | smaže i `:mup-bundle` |

`setup`, `proxy`, `mongo`, `docker` a hooks se nemění.

## 5. Kód

- **`src/build/bundle-image.ts` (nový):**
  - vytvoření `bundle.tar.gz` (§4.2);
  - vytvoření image z base image (create, cp tar proudem, commit, úklid kontejneru);
  - stavba proudu tar s položkami podle tabulky v §4.2.
- **`src/build/index.ts`:**
  - v `buildApp` větev pro bundle mode místo dnešní chyby;
  - režim ve `hashExtras`;
  - informační řádek a varování k `--cache-*`.
- **`src/config/validate.ts`:** varování z §4.6.
- **`src/deploy/preflight.ts`:** v bundle mode vynechat kontroly buildx a platforem (§4.7).
- **`src/deploy/health-check.ts`, `templates/comet/health-check.sh`:** +12 s pro kontejner s labelem `comet-deploy.bundle=1` (§4.4).
- **`templates/comet/bundle-adopt.sh` (nový), `src/remote/ops.ts`, `src/deploy/activate.ts` a restart v `src/deploy/pipeline.ts`:** převzetí podle §4.5 (v aktivaci ve stejném místě jako převzetí po registry, v `restart` před startem každého serveru).
- **`templates/comet/destroy-extra.sh` (nebo ekvivalent):** smazat i `:mup-bundle`.
- **`templates/comet/zd-start.sh`, `templates/comet/zd-finish.sh`:** přesun mazání `current` (§4.4).
- **`package.json`:** závislost `tar`.
- **Dokumentace:** podle §7.

## 6. Testy

**Unit:**
- Bundle mode podle `prepareBundleSupported`: `kadirahq/meteord` bez `prepareBundle`, `zodern/meteor:root` s `prepareBundle: false`, `abernix/meteord` (prepare mode), vlastní image (bundle mode).
- `buildApp` v bundle mode:
  - nevolá buildx;
  - volá create s platformou, cp a commit s labelem;
  - dočasný kontejner smaže i při chybě commitu;
  - chybějící verze Node nevadí;
  - chyba create dá text z §4.3;
  - hash vstupů se liší od prepare mode;
  - `--cache-*` dá varování;
  - `buildInstructions` se nepoužijí.
- Archiv `bundle.tar.gz`: všechny položky začínají `bundle/`, je to gzip.
- Proud tar pro `docker cp`: přesně dvě položky z tabulky §4.2 s vlastníkem 0:0 a právy 755/644.
- Validace: obě varování z §4.6; žádné v prepare mode; žádné pro `zodern/meteor:root` ani pro `zodern/meteor:1.2.3-root`.
- Preflight v bundle mode bez kontroly buildx a platforem.
- Health check: kontejner s labelem `comet-deploy.bundle=1` → `deployCheckWaitTime + 12`, bez labelu beze změny.
- Image s bundlem má labely `comet-deploy.version` a `comet-deploy.bundle=1`.
- Převzetí:
  - kontejner s mountem `/bundle` z `/opt/<app>/current` a s `bundle.tar.gz` → create, cp, commit na `:latest` i `:mup-bundle` s labelem, výstup `adopted`;
  - předchozí image s `:mup-bundle` bez tagů a bez kontejneru se smaže;
  - bez mountu nebo bez souboru → nic;
  - v aktivaci `deploy`, `reconfig` a `rollback` před snímkem a přetagováním, v `restart` před startem každého serveru.
- `listVersions` tag `:mup-bundle` nevrací; `meteor destroy --force` ho smaže.
- `zd-start.sh` už nemaže `current`; `zd-finish.sh` ho smaže až po odstranění starého kontejneru, jen při úspěchu a jen když nový kontejner `current` nemountuje.

**Integrace s lokálním Dockerem, bez sítě:** malý base image postavený v testu z lokálního image, s `ONBUILD RUN exit 1` a s ENTRYPOINT, který vypíše obsah `/bundle`. Pak:
- vytvoření image s bundlem projde (ONBUILD se nespustí);
- ENTRYPOINT zůstane;
- `/bundle` a `bundle.tar.gz` mají vlastníka a práva z §4.2;
- label je na místě;
- dočasný kontejner nezůstane.

**Integrace na fake serverech s MUP 1.5.11** (`zodern/meteor:root`, `prepareBundle: false`, vyšší `deployCheckWaitTime`):
1. `mup setup` a `mup deploy` → aplikace odpovídá a kontejner má mount `/bundle`.
2. Změna, `comet-deploy deploy` → odpovídá nová verze, kontejner nemá mount `/bundle` a `:previous` je převzatá verze MUP.
3. `comet-deploy rollback` → odpovídá verze MUP (převzatý image, kontejner bez mountu).
4. Změna, `mup deploy` hned po tom rollbacku → odpovídá nová verze MUP v bundle mode (ověří `:mup-bundle`: `docker rmi :latest` v MUP projde).
5. Změna, `comet-deploy deploy` → `:previous` je ta verze MUP; pak `mup reconfig` → odpovídá verze z comet-deploy.
6. Změna, `mup deploy`, pak `comet-deploy restart` → odpovídá stejná verze MUP, kontejner běží z převzatého image bez mountu a `:mup-bundle` je na serveru jen jeden.

Existující integrační testy (prepare mode, proxy včetně zero-downtime, stream, registry) musí projít beze změny.

## 7. Dokumentace

- **configuration.md:**
  - zrušit „Planned for phase 2“ (zbude jen poznámka u `docker.image`);
  - nová sekce o bundle mode: kdy nastane, co image obsahuje, pomalejší start, +12 s, `buildInstructions`, `zodern/meteor:root`, doporučení prepare mode;
  - řádek `image` bez odkazu na fázi 2.
- **how-it-works.md:** build v bundle mode, převzetí po MUP v bundle mode, zero-downtime a `current`.
- **migrating-from-mup.md:**
  - odstranit řádek bundle mode z „Check first“;
  - „What changes“: bundle jako vrstva image místo SFTP uploadu, start beze změny;
  - side by side s MUP v bundle mode;
  - řádek v tabulce rozdílů.
- **troubleshooting.md:**
  - base image není pro platformu;
  - non-root `zodern/meteor` v bundle mode;
  - health check vyprší kvůli instalaci při startu;
  - zrušit „Not supported yet (phase 2)“, pokud zbude jen `ssh` a `meteor debug`, nebo ho zkrátit.
- **README:** stav, omezení, roadmapa (bundle mode hotový), FAQ „Do I have to change my mup.js?“.
- **commands.md:** build v deployi (bundle mode bez buildx).

## 8. Co je na implementátorovi

- Jak přesně vypadá proud tar pro `docker cp` (node-tar s explicitními hlavičkami, nebo vlastní zápis ustar). Musí ale dát přesně §4.2.
- Jména funkcí a souborů, pokud odpovídají §5.
- Jak `bundle-adopt.sh` sestaví proud tar na serveru (GNU tar pod `sudo`). Musí dát totéž co §4.2 a uklidit po sobě i při chybě.
- Dělení testů do souborů a pořadí kroků integračního testu, pokud pokryje §6.
