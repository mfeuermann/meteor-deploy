# comet-deploy projekt 8: certifikáty proxy

Stav: návrh, 2026-11-17. Navazuje na návrh proxy (fáze 2) a na seznam vylepšení po vydání 0.6.1 (body 1 a 2: platnost certifikátů ve `status`, kontrola certifikátu po deployi).

Uživatel rozhodnutí o návrhu nechal na mně, stejně jako u projektů proxy, mongo, hooks, stream, registry, bundle mode a příkazů. Moje volby jsou označené [moje volba].

Builder check (2026-11-17) otevřel tři otázky, všechny jsem rozhodl sám:
1. Certifikát, který na doménu nepasuje (výchozí self-signed `default.crt` companionu, certifikát nadřazené domény nebo jiné aplikace), je samostatný problém s vlastním varováním. Handshake bez certifikátu je v tomhle nastavení vzácný (§4.1, §4.2).
2. `proxy setup` kontrolu přeskočí, když na proxy serveru žádný kontejner nemá pro doménu `VIRTUAL_HOST` (čerstvý server). Když kontejner aplikace pořád žádá Let's Encrypt, `proxy setup` místo kontroly varuje, ať se spustí `reconfig` nebo `deploy`. Přechod dokončí až nový kontejner (§4.3).
3. Krok, který nahradí symlinky obyčejnými soubory, se dodá vždy, když `ls -l` ukáže zápis přes symlink. Opakování v `after` se dodá, jen když reprodukce ukáže, že companion zasáhl během rolloutu nebo po něm. Plán po reprodukci pokračuje sám a výsledek zapíše do ledgeru (§4.4).

## 1. Proč

- **Pád v CI 2026-11-17** (run 44042336309, první pokus): integrační test proxy 7 přepne aplikaci z Let's Encrypt na vlastní certifikát (`proxy.ssl.crt`). Deploy skončil s kódem 0, ale proxy do 30 sekund neservírovala nový certifikát. Opakovaný běh prošel. Test vypsal jen `expected false to be true`, takže nevíme, co proxy servírovala.
- **Pravděpodobná příčina (nepotvrzená, ověří ji §4.4):** MUP `ssl-setup.sh` kopíruje certifikát příkazem `cp $APP_CERTS/bundle.crt $MOUNTED_CERTS/$DOMAIN.crt`. Po Let's Encrypt je `mounted-certs/<doména>.crt` symlink companionu (`jrcs/letsencrypt-nginx-proxy-companion`) na `./<doména>/fullchain.pem`. `cp` tedy zapíše vlastní certifikát do souboru Let's Encrypt a symlink nechá. Jakmile zmizí starý kontejner aplikace s `LETSENCRYPT_HOST`, companion smaže symlinky domén, které už nespravuje, a certifikát domény zmizí. Druhá možnost: companion symlink obnoví (`ln -sf`), dokud starý kontejner ještě běží. V obou případech deploy hlásí úspěch a web servíruje jiný certifikát nebo žádný. MUP má stejné skripty, takže tuhle chybu má nejspíš taky.
- **Nikdo nevidí, co nginx skutečně servíruje.** `proxy status` (a tedy `status`) ukazuje MUP kontrolu `mounted-certs/*.chain.pem`: datum vypršení souborů Let's Encrypt na disku. Vlastní certifikát v ní není vůbec a soubor na disku nemusí být to, co nginx servíruje. HTTP sloupec ve `status` měří z tohoto počítače a u chyby certifikátu řekne jen `TLS error`.
- **Selhané obnovování Let's Encrypt je tiché.** Companion obnovuje 30 dní před vypršením. Když to selhává, nikdo se to nedozví, dokud certifikát nevyprší.

## 2. Cíle

1. `proxy status`, a tím i `status`, ukáže pro každý proxy server a každou doménu aplikace certifikát, který nginx skutečně servíruje: vydavatele, datum vypršení a počet dní do něj. U vlastního certifikátu řekne, jestli je to ten z `proxy.ssl.crt`. Problémy ukáže jako varování.
2. `deploy`, `reconfig` a `proxy setup` s vlastním certifikátem skončí tak, že ho každý proxy server servíruje pro každou doménu aplikace. Jinak skončí varováním, které řekne, který server servíruje co.
3. Příčina pádu testu 7 je potvrzená a opravená, takže přechod z Let's Encrypt na vlastní certifikát je stabilní. Integrační test to dokazuje deterministicky: certifikát se servíruje i poté, co companion zpracoval odchod starého kontejneru.
4. Integrační testy certifikátů při selhání vypíšou, co viděly.
5. Dokumentace odpovídá (§7).

## 3. Necíle, anti-cíle, omezení

- **Necíle:**
  - kontrola z tohoto počítače přes DNS nebo CDN (to už dělá HTTP sloupec `status`);
  - monitoring a upozornění mimo běh příkazu;
  - vlastní obnovování Let's Encrypt;
  - `status --json`;
  - ověření důvěryhodnosti řetězce, OCSP;
  - certifikáty jiných aplikací na sdílené proxy;
  - kontrola po `restart` a `rollback`, které certifikáty nemění;
  - kontrola Let's Encrypt po deployi (vydání certifikátu trvá minuty a běží nezávisle na deployi).
- **Anti-cíle:**
  - Cokoli z `private.key` ve výstupu, v logu nebo v přenosu zpět ze serveru. Klíč se ze serveru nikdy nečte.
  - Restart proxy kontejnerů kvůli certifikátu: přeruší všechny aplikace na serveru.
  - Zásah do certifikátů jiných aplikací na sdílené proxy.
  - Deploy, který čeká dlouho: kontrola má pevný strop (§4.3).
  - Jiný koncový stav souborů, než jaký chce MUP. Po comet-deploy vidí MUP stejné rozložení: symlinky v `certs/`, kopie v `mounted-certs/`.
- **Omezení:**
  - `openssl` na serveru. MUP `proxy status` ho už používá (`sudo openssl x509`). Bez něj kontrola řekne, že nejde provést, a nic nerozbije.
  - `status` dál spustí na každém proxy serveru jeden skript (`proxy-status.sh`).
  - Certifikát se rozebírá v Node (`crypto.X509Certificate`), ne textovým parsováním výstupu `openssl`.
  - Node ≥ 20.
  - Šablony MUP (`templates/mup/**`) zůstanou beze změny. Kroky navíc jsou v `templates/comet/`.

## 4. Chování

### 4.1 Servírovaný certifikát

Pro doménu `D` na proxy serveru se comet-deploy připojí na `127.0.0.1:<publikovaný HTTPS port kontejneru mup-nginx-proxy>` se SNI `D`:

```bash
timeout 5 openssl s_client -connect 127.0.0.1:$PORT -servername "$D" </dev/null 2>/dev/null
```

Z výstupu vezme první certifikát v PEM (list) a pošle ho jako base64 na jednom řádku. Node z něj přečte otisk SHA-256, `validTo`, vydavatele (`O` a `CN`), `CN` subjektu a SAN. Jestli certifikát na doménu pasuje, určí `X509Certificate.checkHost(D)`, které počítá i s wildcard a SAN.

Výsledek pro jednu doménu je jeden z těchto stavů:
- `cert`: certifikát;
- `none`: handshake selhal nebo nepřišel žádný certifikát;
- `no-openssl`: na serveru chybí `openssl`;
- `no-https`: proxy nemá publikovaný HTTPS port nebo neběží.

Domény jsou domény aplikace (`proxyDomains(c)`), nikdy jiné aplikace na stejné proxy.

Očekávaný vlastní certifikát je první certifikát v lokálním souboru `proxy.ssl.crt` (otisk SHA-256 přes `X509Certificate`). Když se soubor nedá přečíst nebo rozebrat, porovnání se přeskočí a ukáže se jen vydavatel.

### 4.2 `proxy status` a `status`

MUP blok `=> Reverse Proxy Status` zůstane, jak je. Na konec každého serveru přibude:

```
   - Served certificates:
     - app.example.com: Let's Encrypt (R11), expires 2027-02-01 (76 days)
     - www.example.com: proxy.ssl.crt, expires 2026-12-01 (14 days)
```

- **Popisek:** `proxy.ssl.crt`, když otisk sedí s lokálním souborem. Jinak vydavatel `O (CN)`, nebo jen `CN` bez `O`. Když je v configu vlastní certifikát a otisk nesedí, za popiskem stojí `, not the certificate from proxy.ssl.crt`.
- **Certifikát, který na doménu nepasuje** (`checkHost` nic nevrátí): za popiskem stojí `, not for app.example.com (CN=<CN subjektu>)`. Typicky jde o výchozí certifikát companionu po ztrátě certifikátu domény. U takového certifikátu se varování o vypršení nevypisují, protože hlavním problémem je, že je cizí [moje volba].
- **Datum:** UTC ve tvaru `YYYY-MM-DD`. Dny do vypršení se počítají jako `floor((validTo − teď) / 1 den)`. Vypršelý certifikát: `expired on 2026-11-10`.
- **Ostatní stavy:** `no certificate (TLS handshake failed)`, `cannot check: openssl is not installed on the server`. Při `no-https` se řádky nevypíšou, protože o neběžící proxy už mluví MUP blok.
- **Varování** (`reporter.warn`, za blokem, jedno na problém):
  - certifikát vypršel;
  - zbývá mu ≤ 14 dní [moje volba: Let's Encrypt obnovuje 30 dní předem, takže 14 dní znamená, že obnovování dva týdny selhává, a u vlastního certifikátu jsou to dva týdny na výměnu];
  - certifikát na doménu nepasuje;
  - vlastní certifikát nesedí;
  - doména nemá certifikát.

  Text například: `"one" serves a certificate for app.example.com that expires in 5 days (2026-11-22).` Přesné texty jsou na implementátorovi v tomto duchu.
- **Exit kód** `status` a `proxy status` se nemění.

### 4.3 Kontrola po `deploy`, `reconfig` a `proxy setup`

- **Kdy:** jen s vlastním certifikátem (`customCertFiles(c) !== null`), na každém proxy serveru, kterého se příkaz týkal. Kontroluje se při každém běhu, ne jen když se certifikát změnil [moje volba: jeden `s_client` na doménu je levný a chytí i rozjetý stav]. U `deploy` a `reconfig` se kontroluje v `ProxyRollout.finish` po `after` části synchronizace, kdy už starý kontejner aplikace neběží. U `proxy setup` se kontroluje po přegenerování configu nginx.
- **Jak:** proxy servery paralelně, každé 2 sekundy, nejvýš 30 sekund [moje volba], dokud všechny domény neservírují otisk lokálního `proxy.ssl.crt`.
- **`proxy setup` (a `setup`, který ho spouští)** nemění kontejnery aplikace. Proto navíc:
  - **Čerstvý server:** když na proxy serveru žádný kontejner nemá doménu ve `VIRTUAL_HOST`, nginx pro ni nemá vhost a servíruje výchozí certifikát. Kontrola se přeskočí a s `--verbose` se vypíše `[one] certificate not checked: the app does not run behind this proxy yet`.
  - **Kontejner pořád žádá Let's Encrypt:** když některý kontejner aplikace na proxy serveru (kontejner aplikace nebo `mup-proxy-configure-<app>`) má doménu v `LETSENCRYPT_HOST`, companion by svoje soubory zase nalinkoval. Kontrola se přeskočí a vypíše se varování `"one": the running app still asks Let's Encrypt for app.example.com. Run "comet-deploy reconfig" to switch it to proxy.ssl.crt.` Přechod dokončí `reconfig` nebo `deploy`.
- **Nesedí ani po 30 s:** varování do souhrnu, k ostatním varováním proxy:

  ```
  "one" serves another certificate for app.example.com than proxy.ssl.crt: Let's Encrypt (R11), expires 2027-02-01. Run "comet-deploy proxy setup"; "comet-deploy proxy status" shows what each proxy serves.
  ```

  Exit kód se nemění [moje volba: aplikace běží a ostatní problémy proxy jsou taky varování. Cena, kdyby to bylo špatně: CI s chybným certifikátem neselže]. Jinou hodnotu snadno doplní příznak později.
- **Bez `openssl`:** jedno varování `Could not check the certificate "one" serves: openssl is not installed on the server.`
- **Proxy nedostupná:** pokryjí ji existující varování proxy, nic dalšího se nepřidá.
- **`--verbose`:** řádek `[one] serves proxy.ssl.crt for app.example.com, www.example.com`.

### 4.4 Příčina pádu testu 7 a oprava

1. **Reprodukce (první úkol plánu)** v integračním harnessu:
   - setup a deploy s Let's Encrypt (Pebble), jako test 1+2;
   - deploy s vlastním certifikátem;
   - počkat, až companion zpracuje odchod starého kontejneru (v logu companionu, nejvýš 60 s);
   - pak zapsat servírovaný certifikát, `ls -l` adresářů `/opt/mup-nginx-proxy/certs` a `mounted-certs` a konec logu companionu.

   Podle hypotézy z §1 bude `mounted-certs/<D>.crt` nejdřív symlink na `./<D>/fullchain.pem` s vlastním certifikátem a potom zmizí.
2. **Oprava, pokud se hypotéza potvrdí** [moje volba]:
   - Krok comet-deploy před MUP `ssl-setup.sh` smaže `mounted-certs/<D>.crt` a `mounted-certs/<D>.key`, když jsou to symlinky. `cp` pak vytvoří obyčejné soubory, kterých se úklid companionu netkne. Symlinky companion vytváří, obyčejné soubory nemaže.
   - Při přechodu z Let's Encrypt (pozná se tak, že `mounted-certs/<D>.crt` byl symlink, nebo že běžící kontejner aplikace má `LETSENCRYPT_HOST`) se krok certifikátů a přegenerování configu zopakují v `after` části synchronizace. V tu chvíli starý kontejner s `LETSENCRYPT_HOST` už neběží, takže companion doménu nespravuje a nic nepřepíše.
3. **Jiná příčina:** oprava se řídí skutečnou příčinou. Cíl §2.3 a test z §6 zůstávají. Potvrzená příčina se zapíše do ledgeru plánu a do troubleshootingu.
4. **Neprůkazný výsledek** [moje volba]:
   - Když `ls -l` ukáže, že `cp` zapsal přes symlink do souborů Let's Encrypt, dodá se náhrada symlinků obyčejnými soubory vždy. Je to chyba sama o sobě: při obnově by companion vlastní certifikát přepsal.
   - Opakování v `after` se dodá, jen když reprodukce ukáže, že companion zasáhl během rolloutu nebo po něm (symlink zmizel nebo byl obnoven).
   - Když rozšířený test 7 před opravou nespadne, zůstane jako regresní test. Do ledgeru se zapíše „nereprodukováno deterministicky“ a §2.3 se posoudí podle mechanismu: obyčejný soubor úklid companionu nesmaže a opakování proběhne až bez kontejneru s `LETSENCRYPT_HOST`.
   - Plán po reprodukci pokračuje sám, bez čekání na rozhodnutí.
5. **Přechod z vlastního certifikátu na Let's Encrypt** se nemění: MUP `ssl-cleanup.sh` smaže kopie i symlinky aplikace a companion vytvoří své. Kontrola z §4.3 se na Let's Encrypt nevztahuje.

### 4.5 Diagnostika v integračních testech

V `test/integration/proxy.test.ts` vznikne helper `expectServed(server, fingerprint)`. Když se otisk do timeoutu neobjeví, test selže se zprávou, která obsahuje:
- subjekt, vydavatele a otisk servírovaného certifikátu (nebo „no certificate“);
- `ls -l` adresářů `certs` a `mounted-certs`;
- posledních 40 řádků logu companionu.

Testy 7 a 1+2 ho použijí místo `expect(await waitFor(...)).toBe(true)`.

## 5. Kód

- **`src/proxy/certs.ts`** (nový, čisté funkce, unit testy):
  - rozbor výstupu skriptu (`served=<doména> <base64|-|noopenssl|nohttps>`);
  - `describeServed(result, expectedFingerprint, now)` vrátí popisek, datum, dny a problémy;
  - otisk lokálního `proxy.ssl.crt`.
- **`templates/comet/proxy-status.sh`:** domény aplikace jako proměnná šablony, na každou jeden řádek `served=`. Úsek se `s_client` sdílí s kontrolou po deployi (vlastní šablona přes `include`, např. `proxy-served.sh`).
- **`src/proxy/setup.ts`:**
  - `ProxyStatusRow` dostane `served`;
  - `formatProxyStatus` vypíše řádky z §4.2;
  - `showProxyStatus` vypíše varování;
  - `proxy setup` provede kontrolu z §4.3.
- **`src/proxy/rollout.ts`:** `finish` po `syncAfter` zavolá kontrolu z §4.3 přes závislost v `ProxyRolloutDeps` (testovatelné bez SSH) a přidá varování.
- **`src/proxy/sync.ts`:** oprava z §4.4, kroky comet-deploy kolem MUP `ssl-setup.sh` (nová šablona v `templates/comet/`), opakování v `after` při přechodu z Let's Encrypt.

## 6. Testy

- **Unit:**
  - rozbor řádků `served=` (platný PEM, `-`, `noopenssl`, `nohttps`, poškozené base64);
  - `describeServed`: Let's Encrypt, vlastní sedí, vlastní nesedí, bez `O` ve vydavateli, 15/14/0 dní, vypršelý, cizí certifikát (jiná doména, výchozí certifikát companionu), wildcard, který doménu pokrývá;
  - otisk lokálního souboru s řetězcem (bere se první certifikát), nečitelný soubor;
  - `formatProxyStatus` s řádky z §4.2;
  - varování `status`;
  - kontrola po deployi s falešným zdrojem: sedí hned, sedí po třetím pokusu, nesedí do stropu (falešné hodiny, žádné skutečné čekání), `no-openssl`, bez vlastního certifikátu se nevolá;
  - `finish` přidá varování;
  - `proxy setup` přidá varování; přeskočí kontrolu bez kontejneru s `VIRTUAL_HOST` domény; místo kontroly varuje, když kontejner aplikace má `LETSENCRYPT_HOST`;
  - oprava §4.4: plán kroků při přechodu z Let's Encrypt (opakování v `after`) a bez něj (žádné opakování).
- **Integrace (fake server, Pebble):**
  - Test 7 rozšířený: po přechodu z Let's Encrypt se počká, až companion zpracuje odchod starého kontejneru (nejvýš 60 s), a vlastní certifikát se servíruje pořád. Před opravou tenhle test spolehlivě selže, nebo reprodukce ukáže jinou příčinu (§4.4). Druhý deploy s novým certifikátem ho vymění.
  - `proxy status` po testu 7 ukáže `Served certificates` s `proxy.ssl.crt`. Po testu 1+2 ukáže vydavatele Pebble.
  - Nesedící certifikát: na serveru se ručně podstrčí jiný soubor do `mounted-certs` a pak `nginx -s reload`. `proxy status` varuje a `deploy` skončí s varováním z §4.3 a kódem 0.
- **Interop s MUP:** existující interop testy proxy zůstanou zelené. Po přechodu přes comet-deploy je rozložení souborů stejné jako po MUP.

## 7. Dokumentace

- **commands.md:**
  - `proxy status`: řádky „Served certificates“ a varování;
  - `deploy`: krok kontroly vlastního certifikátu;
  - `reconfig` a `proxy setup`: stejná kontrola.
- **troubleshooting.md:**
  - proxy servíruje jiný certifikát;
  - certifikát Let's Encrypt brzy vyprší (log companionu přes `proxy logs-le`);
  - na serveru chybí `openssl`.
- **migrating-from-mup.md:** rozdíl, jen pokud se potvrdí příčina z §4.4: comet-deploy při přechodu z Let's Encrypt na vlastní certifikát certifikát neztratí, MUP ano.
- **CHANGELOG.md:** `[Unreleased]`.

## 8. Co je na implementátorovi

- Přesné texty varování mimo ty uvedené v §4.2 a §4.3.
- Jestli `status` a kontrola po deployi sdílí jeden skript, nebo jen jeho úsek přes `include`.
- Jak přesně poznat přechod z Let's Encrypt (§4.4 dává dvě možnosti).
- Jak v integračním testu poznat, že companion zpracoval odchod starého kontejneru (řádek v logu, nebo pevné čekání s horní mezí).
