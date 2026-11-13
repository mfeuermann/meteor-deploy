# comet-deploy fáze 2, projekt 4: přenos image bez TCP forwardingu (`transfer: 'stream'`)

Stav: návrh, 2026-11-13. Navazuje na hlavní návrh `2026-11-07-comet-deploy-design.md` (§9 Přenos na servery, bod 3) a na fázi 1, kde se image posílá jen přes SSH reverse tunel do lokálního registry.

Uživatel rozhodnutí o návrhu nechal na mně, stejně jako u projektů proxy, mongo a hooks. Moje volby jsou označené [moje volba].

## 1. Proč

Dnes comet-deploy posílá image na servery jen přes SSH reverse tunel. Na serveru s `AllowTcpForwarding no` (častá úprava při zabezpečení serveru) preflight skončí chybou a deploy tam nejde. MUP forwarding nepotřebuje, protože bundle nahrává přes SFTP. Takový server je tak pro přechod z MUP překážka, kterou uživatel bez přístupu k `sshd_config` (sdílený hosting, správa jiným týmem) neodstraní.

Hlavní návrh pro to počítá se záložním přenosem `stream`: `docker save | komprese | ssh 'docker load'`. Přenese celý image, je pomalejší, ale funguje všude, kde funguje SSH a Docker.

## 2. Cíle

1. **Deploy funguje i na serveru bez TCP forwardingu**, bez jakékoli změny na serveru, a v režimu `auto` bez změny configu.
2. **`cometDeploy.transfer`** má tři platné hodnoty, které comet-deploy umí: `auto` (výchozí), `tunnel` a `stream`. `registry` zůstává odmítnuté do dalšího projektu.
3. **Stejný výsledek jako tunel:** po distribuci má server přesně tag `mup-<app>:<verze>` (resp. tag, který distribuce tunelem vytváří) a žádné další tagy. Aktivace, rollback, historie a pročištění verzí nepoznají, kudy image přišel.
4. **Rozumná rychlost:** image se pro každou platformu uloží a zkomprimuje jen jednou, na servery jde paralelně. Server, který tuto verzi už má, nedostane nic.
5. **Jasný výstup:** uživatel ví, které servery dostávají celý image a proč, a co má změnit, aby to bylo rychlejší.

## 3. Necíle, anti-cíle, omezení

**Necíle:**
- Posílat jen chybějící vrstvy bez forwardingu (např. přes unix socket forwarding nebo `socat` na serveru). Případně později.
- Komprese zstd/xz nebo volba úrovně komprese v configu.
- Navázání přerušeného přenosu.
- Režim `registry` (`privateDockerRegistry`): samostatný další projekt.

**Anti-cíle (selhání, i kdyby to technicky fungovalo):**
- Distribuce, která změní běžící aplikaci. Platí totéž co u tunelu: selhání na kterémkoli serveru zastaví deploy před aktivací a žádný server se nezmění.
- Lokální dočasný soubor s image, který po deployi zůstane na disku (ani po chybě nebo Ctrl+C).
- Tiché přepnutí na pomalý přenos: každý server, který dostává celý image, je ve výstupu vidět s důvodem.
- `tunnel` znamenající něco jiného než dnes: kdo si tunel vynutil, dostane chybu jako dnes, ne tichý `stream`.

**Omezení:**
- Lokálně je potřeba jen Docker (`docker save`), který deploy už vyžaduje. Komprese běží v Node (`zlib`), bez externího `gzip` [moje volba].
- Na serveru stačí `sudo docker load`, které Docker 18+ (minimum comet-deploy) umí včetně gzip archivu.

## 4. Chování

### 4.1 Volba přenosu pro každý server

| `cometDeploy.transfer` | Forwarding funguje | Forwarding odmítnutý |
|---|---|---|
| `auto` (výchozí) | tunel | `stream` + varování |
| `tunnel` | tunel | chyba preflightu jako dnes (text doplněný o radu) |
| `stream` | `stream` | `stream` |

- **Preflight** u `auto` a `tunnel` zkouší forwarding jako dnes (`probeForwarding`); u `stream` se zkouška vynechá.
- **Varování u `auto`**, jednou za server v preflightu:
  `Server "two": SSH port forwarding is off (<důvod>), so comet-deploy sends the whole image over SSH, which is slower. To send only the changed layers, set "AllowTcpForwarding yes" in /etc/ssh/sshd_config and reload sshd.`
- **Chyba u `tunnel`** zůstane jako dnes a dostane radu: `… or set cometDeploy.transfer to "auto" to send the whole image over SSH instead.`
- **Selhání tunelu až při distribuci** (preflight prošel, ale `openReverseTunnel` vyhodí `TunnelUnavailableError`): u `auto` se ten server přepne na `stream` se stejným varováním [moje volba]. U `tunnel` je to chyba distribuce jako dnes.
- **Lokální registry** (kontejner a lease) se spustí, jen když aspoň jeden server používá tunel. Při čistém `stream` se nespouští vůbec.

### 4.2 Přenos `stream`

**Jak se pozná stejný image.** Podle tagu verze, ne podle `.Id` [moje volba]. `.Id` znamená v klasickém úložišti Dockeru digest konfigurace, v úložišti containerd (výchozí pro nové instalace Docker Engine 29 a Docker Desktop 4.34+) digest manifestu. Mezi počítačem a serverem s různým úložištěm by se tedy nikdy neshodlo. Verze je pro každý build jedinečná a build cache ji znovu použije jen pro stejný obsah, takže cílový tag `mup-<app>:<verze>` na serveru znamená stejný image.

**Jednou za platformu**, kterou potřebuje aspoň jeden `stream` server, který verzi ještě nemá:
- `docker save <lokální tag>` → gzip v Node → dočasný soubor v `os.tmpdir()` s právy `600` a jménem, které obsahuje aplikaci, verzi a platformu.
- Archiv obsahuje jen image této platformy, i když lokální Docker používá úložiště containerd (tam `docker save` bez `--platform` exportuje celý index i s attestation manifesty). Archiv musí jít načíst do Dockeru 18+ na serveru; integrační test ho načte do obou verzí Dockeru, které falešné servery nabízejí (27.5 a 29).
- Velikost souboru se vypíše (`stream: mup-myapp:<verze> (linux/amd64), 312 MB compressed`).
- Soubor se smaže na konci fáze Distribute ve všech případech (úspěch, chyba, Ctrl+C): `finally` a registrovaný úklid při ukončení procesu [moje volba: oba].

**Na každém `stream` serveru paralelně:**
1. **Má už tuto verzi?** `sudo docker image inspect <cílový tag>` uspěje → přenos se přeskočí (`already on the server`). To se kontroluje u všech `stream` serverů ještě před `docker save`, takže když verzi mají všechny, nic se neukládá.
2. **Jinak nahraje** soubor jako stdin příkazu `sudo docker load` přes SSH (stávající `exec` se streamem na stdin). Nic se nezapisuje do dočasného souboru na serveru.
3. **Otagování:** po `docker load` má server image pod tagem z archivu. Výsledkem musí být přesně cílový tag z §2 bod 3. Pomocný tag, který cílový není, se odstraní (jen tag, ne image).
4. **Kontrola:** výstup `docker load` musí hlásit načtený image (`Loaded image: …` nebo `Loaded image ID: …`) a cílový tag musí potom na serveru existovat, jinak chyba distribuce na tom serveru.

**Průběh:**
- Řádek serveru ve výstupu ukazuje `distribute running` a na konci `ok <čas> (whole image, 312 MB)` nebo `ok (already on the server)`.
- S `--verbose` se vypisuje průběh odeslaných bajtů zhruba po 10 % (`sent 96 MB of 312 MB`).

### 4.3 Chyby

- **Lokální `docker save` selže** (např. plný disk): CometError `Saving mup-myapp:<verze> for the transfer over SSH failed: <stderr>`. Deploy skončí před distribucí a žádný server se nezmění.
- **`docker load`, spojení nebo kontrola po načtení selže na serveru:** chyba distribuce toho serveru. Platí stávající souhrnná chyba `Image distribution failed: - two: …` s radou `No server was changed.`
- **Ctrl+C** se chová jako u tunelu: fáze Distribute doběhne, pak se deploy ukončí kódem 130, zámky se uvolní a dočasný soubor se smaže.

### 4.4 Kde se to uplatní

Všude, kde se distribuuje: `deploy`, `meteor deploy`, `meteor push` (i s `--cached-build` a v CI). `meteor build` nic neposílá. Hooky se nemění: `meteor.prepareBundle` je dál distribuce, ať jde tunelem nebo streamem.

### 4.5 Validace

- `cometDeploy.transfer: 'stream'` přestane být odmítnuté jako phase 2.
- `transfer: 'registry'` a sekce `privateDockerRegistry` zůstávají odmítnuté, jako dnes.

## 5. Kód

- **`src/transfer/stream.ts`** (nový):
  - uložení a komprese image do souboru, s vrácením cesty, velikosti a ID image;
  - přenos na jeden server (kontrola ID, `docker load`, otagování, kontrola);
  - smazání souboru.
- **`src/deploy/preflight.ts`:** výsledek u každého serveru řekne, jestli forwarding funguje; u `auto` je odmítnutý forwarding varování, ne chyba.
- **`src/deploy/pipeline.ts`:** fáze Distribute rozdělí servery na tunel a `stream` podle §4.1. Registry spustí jen pro tunel a soubory připraví jen pro platformy `stream` serverů. Funkce dostane jako závislosti v `PipelineDeps`, aby šly v unit testech nahradit.
- **`assertPhase1Supported`:** pustí `stream`.

## 6. Testy

- **Unit:**
  - volba přenosu ze všech kombinací v §4.1, včetně selhání tunelu až při distribuci;
  - preflight: u `auto` varování, u `tunnel` chyba s novou radou, u `stream` žádná zkouška;
  - `stream.ts` proti falešnému spojení: přeskočení, když server verzi má (a žádný `docker save`, když ji mají všechny), otagování, odstranění pomocného tagu, chyba, když `docker load` nic nenačte nebo cílový tag chybí, smazání souboru i po chybě;
  - registry se nespustí při čistém `stream`.
- **Integrace** (falešné servery, harness umí `allowTcpForwarding: false`):
  - přenos `stream.ts` na server bez forwardingu, s Dockerem 27.5 i 29: na serveru je jen cílový tag a kontejner z něj běží; druhý přenos se přeskočí;
  - deploy ukázkové aplikace na dva servery, jeden s forwardingem a jeden bez, s výchozím `auto`: oba běží novou verzi, výstup obsahuje varování pro server bez forwardingu, `rollback` funguje na obou;
  - `transfer: 'tunnel'` na serveru bez forwardingu: preflight chyba, nic se nezměnilo.

Akceptace na reálném serveru do „hotovo“ nepatří [moje volba]. Na konci ji nabídnu: deploy přes `transfer: 'stream'` na beta serveru (bez změny `sshd`) potřebuje svolení uživatele.

## 7. Dokumentace

- configuration.md: `cometDeploy.transfer` (tabulka §4.1); upravit odstavec „Port forwarding“.
- troubleshooting.md: „AllowTcpForwarding is disabled on the server“ (u `auto` jen varování, jak zrychlit, kdy je to chyba), nová položka pro chybu `docker save`/`docker load`.
- how-it-works.md: fáze Distribute a preflight.
- migrating-from-mup.md, getting-started.md, README: forwarding už není požadavek, jen doporučení pro rychlost; README Limitations a roadmapa.
- commands.md, pokud zmiňuje forwarding u `deploy`.

## 8. Co je na implementátorovi

- Úroveň komprese gzip (rozumný kompromis rychlost/velikost).
- Přesné jméno dočasného souboru a podoba řádků průběhu v rámci §4.2.
- Jak se dočasný soubor uklidí při ukončení procesu (v rámci §3 anti-cíl).
- Rozdělení kódu mezi `stream.ts` a pipeline, pokud zůstane testovatelné přes `PipelineDeps`.
