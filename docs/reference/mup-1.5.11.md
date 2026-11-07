# Meteor Up (mup) 1.5.11 — Compatibility Reference

Source: the published `mup@1.5.11` npm package (compiled `lib/`, `lib/plugins/*/assets/*.sh`, bundled `@zodern/nodemiral@2.0.0-beta.1`, `@zodern/ejs@2.7.5`, `ssh2@1.17.0`, `tar@6.2.1`, `random-seed@0.3.0`, `uuid@7.0.3`). Everything below is from code; docs are cited only where they contradict code.

## Most important facts for a drop-in replacement

1. Config = `require(<cwd>/mup.js)` or `require(--config <path>)`. There is **no `mup.json` auto-detection** (JSON only works via `--config x.json`). Base dir = `dirname(--config)` or cwd. **Validation errors are printed but never abort** a command.
2. Server state is keyed by `app.name`: container `<name>`, dir `/opt/<name>/`, image `mup-<name.toLowerCase()>` (registry: `<imagePrefix>/mup-<lc>`). Tags (non-swarm): only `:build`, `:latest`, `:previous`. No numbered versions, no docker labels, no version-history file.
3. Image mode vs legacy bundle mode is decided **at runtime on the server** by `docker image inspect mup-<lc>:latest`. Prepare-bundle (build an app image) is on by default only for images starting with `zodern/meteor` or `abernix/meteord`. The default image `kadirahq/meteord` means legacy mode: `/opt/<name>/current:/bundle` volume.
4. The app container is (re)created only by `/opt/<name>/config/start.sh` + `/opt/<name>/config/env.list` (uploaded by `envconfig`). `mup start`/`mup restart` re-run these files as they are, so they must always be valid and current.
5. App container: `docker run -d --restart=always --hostname="$HOSTNAME-<name>" --env-file=env.list --name=<name> (--expose=<imagePort> | --publish=<bind>:<PORT>:<imagePort>) …`. Inside the container `PORT` = `docker.imagePort` (default 3000). The host port is `app.env.PORT` (default 80).
6. The proxy is driven by env vars (nginx-proxy/docker-gen watching docker.sock). The app gets `VIRTUAL_HOST`, `VIRTUAL_PORT`, `HTTPS_METHOD`, `LETSENCRYPT_HOST/EMAIL` and `HTTP_FORWARDED_COUNT=1`. Shared containers are `mup-nginx-proxy` (`zodern/nginx-proxy:v1.1.0`) and `mup-nginx-proxy-letsencrypt` (`jrcs/letsencrypt-nginx-proxy-companion:v1.13.1`). State lives in `/opt/mup-nginx-proxy/`.
7. Built-in Mongo: container `mongodb` (`mongo:<version>`, default `3.4.24`), replSet `meteor` with member `mongodb:27017`, data in `/var/lib/mongodb`. The app is linked with `--link=mongodb:mongodb`, and `MONGO_URL` is **forced** to `mongodb://mongodb:27017/<dbName>?replicaSet=meteor`.
8. All remote work is EJS-rendered bash sent as **one ssh `exec` command string** (it is not uploaded), and it uses `sudo` heavily. Files go over SFTP as the SSH user (dirs are chowned to `$USER`). Two files are compared by content: `/opt/mongodb/mongo-start-current.sh` and `/opt/<name>/config/proxy-config-container.sh`. If the content differs, the container is recreated.
9. Deploy runs `meteor build` and a tar.gz (gzip level 9) once, locally. Then it works through the app servers **strictly one at a time, in 4 separate passes**: (a) SFTP upload; (b) remote `docker build`, which runs `npm install` with the **app stopped by default**; (c) upload start.sh/env.list; (d) recreate the container, then the deploy check (curl container-IP:imagePort, any HTTP response counts as OK, 60 s), which auto-reverts to `:previous` on failure.
10. Deterministic values you must reproduce:
    - Load-balancing host port = `require('random-seed').create(app.name).intBetween(10000, 20000)`.
    - Default build dir = `os.tmpdir()/mup-meteor-<uuid.v4({random: 16 × randomSeed.create(appPath)(255)})>`.
    - Mongo dbName = `app.name` with the dots removed.

---

## 1. Config loading & global CLI behaviour

| Item | Behaviour (code) |
|---|---|
| Config file | `--config <p>` → `path.resolve(expandTilde(p))` (relative to **cwd**); default `path.join(base, 'mup.js')`. Loaded with `require()` after deleting it from the require cache. Missing → `"mup.js" file not found … Run "mup init"`, exit 1. Any other error → prints it, exit 1. |
| `mup.json` | Not searched. Only loads via `--config mup.json` (works because of `require`). |
| Base path (`api.getBasePath()`) | `path.dirname(program.config)` (the raw string) if `--config` is given, else `process.cwd()`. |
| Loaded twice | `index.js` creates `preAPI` and calls `getConfig(false)` (load errors → `{}`, problems not printed) to find `plugins` + `hooks`. Each command then builds a fresh `PluginAPI` → fresh `require` → normalise → validate (printed). |
| Settings | `--settings <p>` → resolved against **cwd**; default `<base>/settings.json`. Parsed with `parse-json` (strict JSON). Loaded lazily, only by `meteor.deploy` (as the first step), `meteor.envconfig` (reconfig/deploy) and the swarm start. Missing/invalid → message + exit 1. |
| METEOR_SETTINGS | `JSON.stringify(settings)` (single line) written into `env.list`. `app.servers.<n>.settings: '<path>'` (resolved vs **cwd**) replaces METEOR_SETTINGS for that host. |
| `app` vs `meteor` | `_normalizeConfig`: if `config.meteor` exists and `config.app` is not an object → `config.app = {...config.meteor, type: 'meteor'}`. The `meteor` key is kept in the object (only scrubbed). If `app` has no `type` → `type = 'meteor'`. The meteor plugin only acts when `app.type === 'meteor'`. Validation messages are prefixed `meteor.` when `config.meteor` exists. No deprecation warning for `meteor`. |
| Normalisation | `runConfigPreps`: the `prepareConfig(config, api)` of every plugin in load order: `default`(none) → `docker` → `meteor` → `mongo` → `proxy` → user `plugins`. Return value `|| config`. Details in §2.9. |
| Validation | Joi 15, `{abortEarly:false, convert:false, noDefaults:true}`. Unknown keys are errors (`is an unknown property`). Errors and deprecations are printed once. **Not fatal.** Only `mup validate` sets exit code 1. |
| `--servers <list>` | `program.servers.split(' ')`: **space-separated**, even though the help says "Comma separated" (`--servers one,two` matches nothing → zero sessions). Filters only nodemiral sessions (`getSessions`, `getSessionsForServers`). **Not filtered:** remote hooks (always all `servers`), `mup status` and meteor/docker/mongo/proxy status, and anything using `runSSHCommand(configServer)`. |
| `--verbose` | Streams the remote stdout/stderr of every task-list script. `meteor build` output is always streamed (stdio inherit). |
| `--show-hook-names` | Prints `Hook: pre.<plugin>.<cmd>` / `Hook: post.<plugin>.<cmd>` for every `runCommand`, including nested ones. |
| `--cached-build` | Option on `deploy`, `meteor deploy`, `meteor build`, `meteor push`. If `<buildLocation>/bundle.tar.gz` exists, build and archive are skipped; otherwise it prints "Unable to use previous build" and builds. |
| Other globals | `-v/--version`, `-h/--help`; yargs `strict(true)` (log commands use `strict(false)`). No args → help. |
| `api.getArgs()` | `argv._` plus the options the user actually typed, minus `settings, config, verbose, show-hook-names, help, servers` (e.g. `mup logs -f --tail 50` → `['logs','-f','--tail',50]`). |
| Env vars read | `SSH_AUTH_SOCK` (agent fallback), `MUP_PROFILE_TASKS=true` (prints task durations), `MUP_SKIP_UPDATE_CHECK=true`, `DEBUG=mup:*,nodemiral:*` (debug module). No dotenv; `mup.js` may use `process.env` itself. |
| Env vars set | `METEOR_HEADLESS=1` (meteor build child). `process.env.DOCKER_BUILDKIT='1'` (local prepare-bundle). |
| Update check | Each command starts a background `GET https://registry.npmjs.org/-/package/<name>/dist-tags` for mup and each config plugin. A box is printed on exit if an update is available. |
| Local Node | Requires ≥10.16 (exits otherwise); warns for 14.1–14.15. |
| Server sources / server groups | `lib/server-sources.js` (`registerServerSource`) and `lib/plugins/default/server-groups/*` (DigitalOcean) **are not wired up**: nothing registers or reads them, and they need the missing `ssh2-classic`. Dead code, ignore. The same goes for `lib/check-setup.js` + `tasks/assets/check-setup.sh` (`/opt/.mup-setup/*.txt`), which are never called. |

### Path resolution (which base each path uses)

| Config value | Resolved against |
|---|---|
| `--config`, `--settings`, `servers.*.pem`, `app.servers.*.settings`, `proxy.shared.templatePath` | **process cwd** |
| default `settings.json`, `app.path`, `app.ssl.crt/key`, `proxy.ssl.crt/key`, `proxy.nginxServerConfig`, `proxy.nginxLocationConfig`, `proxy.shared.nginxConfig` | base path |
| `buildOptions.buildLocation` | Passed raw to `meteor build --directory` (child cwd = appPath), but `bundle.tar.gz` is resolved vs cwd → **use absolute paths** |
| plugin names starting `.` `/` `~` | config file dir (`resolve(configPath, '../', name)`) |

---

## 2. Config schema

### 2.1 Top level

Allowed keys: `servers`, `app`, `plugins` (array), `hooks`, `_origionalConfig`, plus any key that has a registered validator: `meteor`, `app`, `swarm`, `privateDockerRegistry` (docker plugin), `mongo`, `proxy`, plus keys from config plugins. **There is no top-level `docker` key** (it would be flagged as unknown, non-fatal).

### 2.2 `servers.<name>`

| Key | Type | Req | Default | Effect |
|---|---|---|---|---|
| `host` | string (trimmed) | yes | – | SSH host. Also the key for per-host template vars. |
| `username` | string | yes | – | SSH user. Dirs are `chown ${USER}`; non-root users need passwordless sudo. |
| `pem` | string | – | – | Path to a private key (resolved vs **cwd**, `~` supported). A path ending in `.pub` → error. Read as file content. |
| `password` | string | – | – | Used if there is no `pem`. |
| `opts` | object, schema allows only `port` (number) | – | port 22 | For nodemiral sessions the **whole object** is merged into the ssh2 connect options (other ssh2 keys work but produce a validation error). mup adds `keepaliveInterval: 28000` and `keepaliveCountMax: 12`; nodemiral uses `readyTimeout: 60000`. |
| `privateIp` | string | – | – | With `proxy.loadBalancing`: the upstream address and the app's `bind` address. |

- Auth precedence: `pem` > `password` > `SSH_AUTH_SOCK` (if the socket exists) > error + exit 1. No key passphrase support (use the agent).
- `runSSHCommand(serverConfig)` (status, hooks, debug, `mup ssh`, mongo shell) uses only host, `opts.port`, username and key/password/agent. Other `opts` are ignored.

### 2.3 `app` (alias `meteor`) — `plugins/meteor/validate.js`

| Key | Type | Default (where set) | Effect |
|---|---|---|---|
| `name` | string ≥1, req, no spaces | – | Container name, `/opt/<name>`, image `mup-<lc name>`. |
| `path` | string ≥1, req | – | App dir (vs base). Must contain `.meteor/release`. |
| `type` | string | `'meteor'` | Other values hand deploy over to plugins. |
| `port` | number | – | Validated, **unused**. |
| `servers` | object, ≥1 key, req | – | Server names (must exist in `servers`). |
| `servers.<n>.env` | object of string/number/bool | – | Merged into this host's env.list. `env.PORT` here = the host publish port for this server (it is **not** put into the container env). |
| `servers.<n>.bind` | string | – | Per-host publish bind IP. |
| `servers.<n>.settings` | string path | – | Per-host METEOR_SETTINGS file. |
| `env` | object; `ROOT_URL` req (`^(http|https)://`), `MONGO_URL` string, others string/number/bool | – | Container env (§4.7). `env.PORT` = host publish port (default 80). Not allowed together with `ssl.autogenerate`. |
| `deployCheckWaitTime` | number (s) | 60 (runtime) | Deploy-check timeout. |
| `deployCheckPort` | number | – | Validated and documented, **ignored** (the check always uses `docker.imagePort`). |
| `enableUploadProgressBar` | bool | false | SFTP progress bar (TTY only). |
| `dockerImage` | string | – | Legacy → moved to `docker.image`, then deleted. |
| `docker.image` | string | `'kadirahq/meteord'` (prepareConfig) | Base image. |
| `docker.imagePort` | number | 3000 (prepareConfig) | Port inside the container. Becomes the container's `PORT` env, `VIRTUAL_PORT` and the deploy-check port. |
| `docker.imageFrontendServer` | string | `'meteorhacks/mup-frontend-server'` (runtime) | **Deprecated.** Legacy SSL frontend. |
| `docker.args` | string[] | `[]` | Appended raw to `docker run` (one string may hold several flags). Mongo adds `--link=mongodb:mongodb`. |
| `docker.bind` | string | `'0.0.0.0'` (runtime) | Publish bind IP. |
| `docker.prepareBundle` | bool | true if the image starts with `zodern/meteor` or `abernix/meteord`, else false | Build an app image on the server. |
| `docker.prepareBundleLocally` | bool | false | Build locally and push to `privateDockerRegistry` (needs `useBuildKit` and the registry). |
| `docker.buildInstructions` | string[] | `[]` | Raw Dockerfile lines (remote prepare only; ignored locally). |
| `docker.stopAppDuringPrepareBundle` | bool | true (prepareConfig) | `docker stop <name>` during the remote build. |
| `docker.useBuildKit` | bool | false | `DOCKER_BUILDKIT=1` with a bind-mount extract. |
| `docker.networks` | string[] | – | `docker network connect <net> <name>` after run (disconnect before). |
| `buildOptions.serverOnly` | bool | – | `--server-only`. |
| `buildOptions.debug` | bool | – | `--debug`. |
| `buildOptions.cleanAfterBuild` | bool | – | Validated, **unused**. |
| `buildOptions.buildLocation` | string | tmp path (prepareConfig) | `meteor build --directory`. |
| `buildOptions.cleanBuildLocation` | bool | **forced `true` when buildLocation is defaulted** | `fs.rm(buildLocation, recursive)` before the build. |
| `buildOptions.mobileSettings` | object | – | `--mobile-settings <JSON string>`. |
| `buildOptions.server` | string uri | – | `--server <url>`. |
| `buildOptions.allowIncompatibleUpdates` | bool | – | Validated, **unused**: build.js reads `allowIncompatibleUpdate` (singular), which fails validation. The flag is never emitted unless the singular key is used. |
| `buildOptions.executable` | string | `'meteor'` | Build executable. |
| `log.driver` | string | – | `--log-driver=`. |
| `log.opts` | object | `{ 'max-size': '100m', 'max-file': 10 }` only if `log` is absent (runtime) | `--log-opt k=v`. |
| `volumes` | object hostPath→containerPath | – | `-v h:c`. |
| `nginx.clientUploadLimit` | string | `'10M'` | **Deprecated** (legacy SSL autogenerate only). |
| `ssl.autogenerate.{email,domains}` | strings, req inside | – | **Deprecated.** Per-app nginx-proxy + LE (§6.6). |
| `ssl.crt`, `ssl.key` | strings (both or neither) | – | **Deprecated.** Legacy frontend container. |
| `ssl.port` | number | 443 (runtime) | Legacy frontend publish port. |
| `ssl.upload` | bool | true | false = certs already on the server. |
| `dockerImageFrontendServer` | – (not in schema) | – | Legacy alias, honoured at runtime. |
| `nodeVersion` | – | – | **Does not exist** in 1.5.11. The Node version comes from the bundle (§4.4). |

Deprecation warnings: `app.ssl`, `app.nginx`, `app.docker.imageFrontendServer`.

### 2.4 `proxy`

| Key | Type | Default | Effect |
|---|---|---|---|
| `domains` | string, req | – | Comma list → `VIRTUAL_HOST`, `LETSENCRYPT_HOST`, vhost.d files. |
| `ssl.letsEncryptEmail` | string | – | Sets `LETSENCRYPT_HOST` + `LETSENCRYPT_EMAIL`. Exclusive with `crt/key`. |
| `ssl.crt`, `ssl.key` | strings (both) | – | Custom certs (§6.4). |
| `ssl.forceSSL` | bool | false | `HTTPS_METHOD=redirect` (else `noredirect`). |
| `ssl.upload` | (not in schema) | true | false = skip the cert upload. |
| (ssl rule) | – | – | Needs one of `letsEncryptEmail`, `crt`, `forceSSL`. |
| `nginxServerConfig` | path (base) | – | Content appended to `vhost.d/<domain>`. |
| `nginxLocationConfig` | path (base) | – | Written to `vhost.d/<domain>_location`. |
| `clientUploadLimit` | string | `'10M'` | `client_max_body_size` in `vhost.d/<domain>`. |
| `servers` | object | app servers | Where the proxy runs (required with swarm). |
| `loadBalancing` | bool | false | Upstream file across app servers (§6.5). |
| `stickySessions` | bool | true | `ip_hash;` in the upstream. |
| `shared.httpPort` / `httpsPort` | number | 80 / 443 | Proxy publish ports (via `shared-config.sh`). |
| `shared.clientUploadLimit` | number/string | `'10M'` | **Deprecated.** Proxy-wide `client_max_body_size`. |
| `shared.nginxConfig` | path (base) | `assets/proxy.conf` (`# Default shared nginx config`) | → `config/nginx-default.conf`. |
| `shared.templatePath` | path (**cwd**) | – | → `config/nginx-shared.tmpl` (overrides nginx.tmpl). |
| `shared.nginxTemplate` | string | – | Validated, **unused**. |
| `shared.env` | object | – | `config/env.list` for nginx-proxy (e.g. `DEFAULT_HOST`). |
| `shared.envLetsEncrypt` | object (`ACME_CA_URI` url, `DEBUG` bool, `NGINX_PROXY_CONTAINER`, any) | – | `config/env_letsencrypt.list`. |

`shared.*` only takes effect via `mup proxy reconfig-shared`. Validation warns if `app.env.PORT` is set (and is not 80) without `loadBalancing` ("ignored").

### 2.5 `mongo`

| Key | Type | Default | Effect |
|---|---|---|---|
| `version` | string | `'3.4.24'` (prepareConfig; `mup init` writes `4.4.12`) | `mongo:<version>`. Major > 5 → `mongosh`, else `mongo` CLI. |
| `dbName` | string | `app.name.split('.').join('')` | DB name in `MONGO_URL`. |
| `dataPath` | string | `/var/lib/mongodb` | Host data dir. |
| `servers` | object, req | – | Must be exactly one, on the **same host as the only app server**, otherwise setup/start silently skip. |
| `oplog`, `port` | bool/number | – | Accepted, **unused**. |

Validation error if the original `app.env.MONGO_URL` contains `.` or `@` (looks external). `MONGO_OPLOG_URL` is never set by mup.

### 2.6 `privateDockerRegistry`

| Key | Type | Effect |
|---|---|---|
| `host` | string, **required by schema** (the changelog says optional; registry API calls default to `registry-1.docker.io`) | `docker login … <host>`. |
| `imagePrefix` | string | Image = `<imagePrefix>/mup-<lc name>` (mup inserts the `/`). |
| `username`, `password` | strings | `docker login` (remote at setup; local for prepareBundleLocally). |

Effects: upload and prepare-bundle run on the **first app server only**, which also pushes `:previous` + `:latest`. Every server's start.sh does `docker pull <prefix>/mup-<lc>:latest` (fails hard). Validation errors are labelled `dockerPrivateRegistry` (typo).

### 2.7 `swarm`

`enabled` bool (req), `labels: [{ name, value, servers: [] }]`. See §10.

### 2.8 `hooks` / `plugins`

`hooks: { '<hookName>': { localCommand?, remoteCommand?, method? } | function(api, nodemiral) }`. `plugins: ['name' | './path' | '~/path' | '/abs']`. See §9.

### 2.9 Normalisation (prepareConfig, in order) and runtime defaults

**meteor** (only if `app.type === 'meteor'`)
- `app.docker = defaultsDeep(app.docker, { image: app.dockerImage || 'kadirahq/meteord', stopAppDuringPrepareBundle: true })`; `delete app.dockerImage`.
- `app.docker.imagePort ||= 3000`.
- `app.buildOptions ||= {}`. If `buildLocation === undefined` → `buildLocation = tmpBuildPath(appPath)` and `cleanBuildLocation = true` (this overrides a user `false`).

**mongo** (if `app` && `mongo`)
- `mongo.version ||= '3.4.24'`; `app.env ||= {}`; `mongo.dbName ||= app.name.split('.').join('')`.
- `app.env.MONGO_URL = 'mongodb://mongodb:27017/' + dbName + '?replicaSet=meteor'` (always overwritten).
- `app.docker.args = [...(args||[]), '--link=mongodb:mongodb']`.

**proxy** (if `app` && `proxy`)
- `env.VIRTUAL_HOST = proxy.domains`; `env.HTTPS_METHOD = ssl.forceSSL ? 'redirect' : 'noredirect'`.
- If `ssl.letsEncryptEmail`: `env.LETSENCRYPT_HOST = domains`, `env.LETSENCRYPT_EMAIL = email`.
- If `loadBalancing`: `env.PORT ||= randomSeed.create(app.name).intBetween(10000, 20000)`, and `app.servers[k].bind = servers[k].privateIp` (when set).
- Non-swarm: `env.VIRTUAL_PORT = docker.imagePort || 3000` (overwrites).
- `env.HTTP_FORWARDED_COUNT ||= 1`.
- Swarm: `docker.networks.push('mup-proxy')`.
- If `proxy.ssl` exists and ROOT_URL starts with `http://` → rewritten to `https:` via `split(':')` / `join('')`. Bug: `http://a.com:3000` becomes `https://a.com3000`.

**docker**: no change.

**Runtime-only defaults** (in `meteor.envconfig`, so not shown by `mup validate --show`)
- `app.log ||= { opts: { 'max-size': '100m', 'max-file': 10 } }`; `app.nginx ||= {}`.
- `docker.imageFrontendServer ||= app.dockerImageFrontendServer || 'meteorhacks/mup-frontend-server'`.
- `ssl.port ||= 443`; bind = `docker.bind || '0.0.0.0'`; host port = `env.PORT || 80`.

### 2.10 scrubConfig (`mup validate --scrub`)

- **servers.\***: `host` → `1.2.3.4`, `password` → `password`, `pem` → `~/.ssh/pem`.
- **meteor/app**: `delete config.meteor`; `app.name` → `my-app`; `buildOptions.server` and `env.ROOT_URL` → scrubUrl. `env.MONGO_URL` → last path segment becomes `my-app` (if mongo), else scrubUrl.
- **registry**: username/password replaced.
- **proxy**: `LETSENCRYPT_EMAIL` and `ssl.letsEncryptEmail` → `email@domain.com`. `VIRTUAL_HOST`, `LETSENCRYPT_HOST`, `domains` and `shared.env.DEFAULT_HOST` → scrubbed domains.
- **scrubUrl**: `proto//[user:pass@]` + `subdomain.` per extra label + `host.com[:port][path][hash]`.

---

## 3. Commands

### 3.1 Execution model

- `api.runCommand('<plugin>.<key>')`:
  1. Pushes onto `commandHistory`.
  2. Runs `pre.<plugin>.<key>` hooks.
  3. Runs `handler(api, nodemiral)`. On a throw → print, `process.exit(1)`; post hooks do **not** run.
  4. Runs `post.<plugin>.<key>` hooks. After the outermost command's post hooks, all SSH sessions are closed.
- Command keys are the JS export names, not the CLI names: `meteor.prepareBundle`, `proxy.reconfigShared`, `proxy.leLogs`, `proxy.nginxConfig`, `docker.destroyCluster`.
- Sessions: one persistent ssh2 connection per server (nodemiral `keepAlive`), opened lazily.
- `executeScript`:
  - The template is rendered **locally** with EJS 2.7 (`<%= %>` HTML-escapes `& < > ' "`; `<%- %>` is raw; `<% include x %>` relative to the script).
  - The rendered text is sent as the ssh `exec` command, so it runs in the remote user's default shell and the shebang is ignored. `mup status` flags a non-bash shell.
  - Non-zero exit = failure; the error includes the last 4200 chars of stderr/stdout.
- `copy`: SFTP as the SSH user (`fastPut` for files; `open w+` / `write` for rendered templates). Retries up to 3× after 3 s / 6 s / 9 s. `No such file` → no retry, hint "run mup setup".
- `hostVars[host]` are deep-merged (`lodash.merge`) into vars per session (keyed by `servers.<n>.host`).
- `runTaskList(list, sessions, { series })`: `series: true` = `async.mapSeries`, i.e. the **whole list on server 1, then server 2…**. Otherwise all servers run concurrently. The first failure rejects → exit 1; in series mode the remaining servers are never touched.

### 3.2 Top-level commands (default plugin; the handlers are mostly no-ops, the work is done by `post.default.*` hooks)

Hook registration order: bundled plugins in alphabetical dir order (`default`, `docker`, `meteor`, `mongo`, `proxy`), then config `plugins`, then config `hooks`.

| CLI | Handler | Then (post.default.* hooks, in order) |
|---|---|---|
| `mup init` | Writes `mup.js` (from `mup.js.sample`, `<app path>` replaced) + `settings.json` (`{"public":{}}`). If cwd is a Meteor app → creates `.deploy/`, appPath `../`. If the parent is a Meteor app → `../`. If the parent has exactly 2 entries and the sibling is a Meteor app → `../<sibling>`. Never overwrites. | – |
| `mup setup` | `docker.setup` (+ swarm). Prints "Next… mup deploy" on clean exit. | `meteor.setup` → (mongo) `mongo.setup`, `mongo.start` → (proxy) `proxy.setup` (→ `proxy.start`; its `post.proxy.setup` runs the LB/swarm config container) |
| `mup deploy [--cached-build]` | no-op | `meteor.deploy` (§4) |
| `mup reconfig` | no-op | `meteor.envconfig`, `meteor.start` → (proxy && (swarm \|\| loadBalancing)) `updateProxyForLoadBalancing` |
| `mup restart` | no-op | `meteor.restart` |
| `mup start` / `stop` | no-op | `meteor.start` / `meteor.stop` |
| `mup logs [docker logs opts]` | no-op | `meteor.logs` |
| `mup status [--overview]` | Fresh SSH per server (concurrency 2): `lsb_release -r -s \|\| echo "false"; lsb_release -is; apt-get -v &> /dev/null && echo "true" \|\| echo "false"; echo $BASH`. Red if there is no apt-get, release ≤13, or $BASH is empty; yellow if not Ubuntu. | `docker.status`, `meteor.status`, `mongo.status`, `proxy.status` (not awaited) |
| `mup ssh [server]` | Interactive ssh2 shell. With no arg: uses the server if only one session is enabled (respects `--servers`), else lists the servers. | – |
| `mup validate [--show] [--scrub]` | Prints problems; `--show` prints the normalised config, `--scrub` the scrubbed one. Exit 1 if there are problems. | – |

### 3.3 `mup meteor <cmd>`

| CLI | What it does |
|---|---|
| `setup` | Parallel on app servers: `meteor-setup.sh` (mkdir `/opt/<name>/`, `config`, `tmp`; `chown ${USER} -R`). Legacy `app.ssl` without autogenerate: `ssl-cleanup.sh` (rm `config/bundle.crt`, `config/private.key`), SFTP crt/key there (unless `upload:false`), then `verify-ssl-config.sh` (runs a `debian` dummy container + `meteorhacks/mup-frontend-server /verify.sh`). |
| `deploy [--cached-build]` | `getSettings()` → `meteor.push` → `default.reconfig`. |
| `push` (hidden) | `meteor.build` → archive (if rebuilt) → [prepareBundleLocally: `meteor.prepareBundle`, return] → SFTP `bundle.tar.gz` → `/opt/<name>/tmp/bundle.tar.gz` (series; first server only with a registry) → `meteor.prepareBundle`. |
| `build` (hidden) | Local build (§4.1). |
| `prepare-bundle` (hidden, key `prepareBundle`) | No-op unless prepareBundle is supported. Local variant, or `prepare-bundle.sh` per server (series; first server only with a registry). |
| `envconfig` (hidden) | Series per app server: SFTP rendered `templates/start.sh` → `/opt/<name>/config/start.sh` and `templates/env.list` → `/opt/<name>/config/env.list`. Skipped under swarm. |
| `start` | Series: `meteor-start.sh` then `meteor-deploy-check.sh`, per server. |
| `stop` | Parallel: `meteor-stop.sh`. |
| `restart` | Series: `meteor-stop.sh` → `meteor-start.sh` → deploy check. |
| `logs [-t N] [-f] [any docker logs opts]` | `sudo docker logs <args> <name> 2>&1` on each app server; each line prefixed `[host]`. |
| `status [--overview]` | Per server (concurrency 2): `sudo docker inspect <name> --format "{{json .}}"`; `curl <bind\|docker.bind\|127.0.0.1>:<PORT>`; `sudo docker exec <name> curl http://localhost:<imagePort>`; a local axios HEAD to `http(s)://<VIRTUAL_HOST[0] or host>[:PORT]`. |
| `debug [server]` | `docker exec -t <name> sh -c 'kill -s USR1 $(pidof -s node)'`; runs `meteor-debug` (`alpine/socat`, `--network=container:<name>`, 9228→127.0.0.1:9229) and `meteor-debug-2` (`-p 9227:9227` → containerIP:9228); then local port forward 0.0.0.0:9229 → server 127.0.0.1:9227. |
| `destroy --force` | Waits 5 s, then series: `meteor-stop.sh` + `meteor-destroy.sh` (`rm -rf /opt/<name>/`; `docker rmi --force mup-<lc>:previous`, `:latest`, `:build`; `docker image prune -f`). Not supported with swarm. Leaves proxy vhost.d files and the `mup-proxy-configure-<name>` container. |

`meteor-stop.sh`: `docker rm -f` and `docker network disconnect bridge -f` for `<name>`, `<name>-frontend`, `<name>-nginx-letsencrypt`, `<name>-nginx-proxy` (all `|| :`).

### 3.4 `mup docker <cmd>`

| CLI | What it does |
|---|---|
| `setup` | Parallel on **unique hosts of app + mongo + proxy servers** (all `servers` when swarm): `docker-setup.sh` (§8), then swarm reconcile. |
| `update` | `docker-update.sh` (= `install_docker`, i.e. the get.docker.com script again), then swarm reconcile. |
| `restart` | `sudo service docker restart`. |
| `ps [opts]` | `sudo docker ps <opts> 2>&1` sequentially on the unique hosts. |
| `status` | All `servers`: `sudo docker version --format "{{.Server.Version}}"` (exit 1 = stopped, 127 = not installed; red if major < 18; warns on mixed versions); plus swarm nodes. |
| `destroy-cluster` | `sudo docker swarm leave --force \|\| true` on all servers. |

### 3.5 `mup mongo <cmd>`

| CLI | What it does |
|---|---|
| `setup` | `mongo-setup.sh` (mkdir + chown `/opt/mongodb`); SFTP rendered `templates/start.sh` → `/opt/mongodb/mongo-start-new.sh`. Skipped (with a message) unless there is exactly 1 app server on the same host. |
| `start` | `mongo-start.sh` (§7). Same skip rule (silent). |
| `stop` | `docker update --restart=no mongodb; docker exec mongodb mongod --shutdown; sleep 2; docker rm -f mongodb`. |
| `logs [opts]` | `docker logs <opts> mongodb`. |
| `shell` | `docker exec -it mongodb mongo\|mongosh <app.name>` (note: `app.name`, not `dbName`; no sudo). |
| `status` | `docker inspect mongodb` plus `mongo --eval JSON.stringify(db.runCommand({serverStatus:1,…}))`. |

### 3.6 `mup proxy <cmd>`

| CLI | What it does |
|---|---|
| `setup` | Parallel on proxy servers (`proxy.servers` or app servers): `proxy-setup.sh`; SFTP `templates/start.sh` → `/opt/mup-nginx-proxy/config/start.sh`; SFTP `nginx.tmpl` → `config/nginx.tmpl`; `nginx-config.sh` (vhost.d per domain); `ssl-cleanup.sh`; [custom certs: SFTP to `/opt/<app>/config/bundle.crt` + `private.key`, then `ssl-setup.sh`]; `upstream.sh`. Then `proxy.start`. Then `post.proxy.setup` → LB/swarm config container. |
| `start` | Series: `sudo bash /opt/mup-nginx-proxy/config/start.sh` (**recreates both proxy containers** → short outage for all apps on the host). |
| `stop` | `proxy-stop.sh` (rm -f + disconnect bridge/mup-proxy for `mup-nginx-proxy` and `-letsencrypt`). |
| `reconfig-shared` | Series: SFTP `shared-config.sh`, `env.list`, `env_letsencrypt.list`, `nginx-default.conf` (from `shared.nginxConfig` or the default), `nginx-shared.tmpl` (or `cleanup-template.sh` removes it). Then `proxy.start`. |
| `logs [opts]` | `docker logs <opts> mup-nginx-proxy`. |
| `logs-le [opts]` | `docker logs <opts> mup-nginx-proxy-letsencrypt` (on **app** servers). |
| `nginx-config` | `docker exec mup-nginx-proxy cat /etc/nginx/conf.d/default.conf`. |
| `status` | Inspects both containers; cert expiry via `openssl x509 -enddate` over `/opt/mup-nginx-proxy/mounted-certs/*.chain.pem`. |
| `envconfig` | Listed in help, but **the handler does not exist** → TypeError. |

---

## 4. Deploy pipeline (`mup deploy`, non-swarm)

Order: `pre.default.deploy` → `default.deploy` (no-op) → `pre.meteor.deploy` → `meteor.deploy`:
1. `api.getSettings()` (exit 1 if missing).
2. `meteor.push` → `meteor.build` → archive → upload → `meteor.prepareBundle`.
3. `default.reconfig` → `meteor.envconfig` → `meteor.start` → [proxy LB hook].
4. `post.meteor.deploy` → `post.default.deploy` user hooks.

### 4.1 `meteor build` (local, once)

- Pre-checks: `appPath` exists; `appPath/.meteor/release` exists.
- If `cleanBuildLocation === true`: `fs.rm(buildLocation, { recursive: true, maxRetries: 10, force: true })`.
- Command: `<executable|meteor> build --directory <buildLocation> --architecture os.linux.x86_64` with optional args appended in this order:
  1. `--debug` (if `debug`).
  2. `--mobile-settings '<JSON.stringify(mobileSettings)>'` (if set).
  3. `--server-only` (if `serverOnly`); **else if** there are no mobileSettings, `--mobile-settings <appPath>/settings.json` (the *app's* settings.json, not mup's).
  4. `--server <url>` (if set).
  5. `--allow-incompatible-update` (only if the key `allowIncompatibleUpdate` is present).
- cwd = appPath, `env = { ...process.env, METEOR_HEADLESS: 1 }`, stdio inherited. Windows: run via `cmd.exe /c`. Non-zero exit → exit 1.
- Output: `<buildLocation>/bundle/` (Meteor). The default buildLocation is `os.tmpdir()/mup-meteor-<seeded uuid>`, which is stable per appPath, so `--cached-build` finds it.

### 4.2 Archive (local)

`tar.c({ file: '<buildLocation>/bundle.tar.gz', cwd: buildLocation, portable: true, gzip: { level: 9 } }, ['bundle'])` with node-tar (in-process JS zlib, single-threaded). Entries are prefixed `bundle/`. Skipped by `--cached-build` when the tarball exists.

### 4.3 Upload

SFTP `fastPut` → `/opt/<name>/tmp/bundle.tar.gz` (overwrite), **series** across app servers. With `privateDockerRegistry` only the first server is used. Not done with `prepareBundleLocally`.

### 4.4 Node version

`getNodeVersion(localTarball)` lists the whole tar.gz (one full decompression pass):
- `bundle/star.json` → `.nodeVersion` (Meteor ≥1.5.2).
- Else `bundle/.node_version.txt` with the leading `v` removed.
- Passed **only** as `--build-arg NODE_VERSION=<x.y.z>` to `docker build`. MUP itself never installs Node: the base image (e.g. `zodern/meteor`) consumes the build arg in its own `ONBUILD` instructions. In legacy bundle mode (no image build) the base image picks Node at runtime.

### 4.5 Remote prepare-bundle (`assets/prepare-bundle.sh`, series, per app server or first only)

Vars: `appName`, `dockerImage`, `env` = `app.env` with only the **first** `"` per value escaped (regex without `g`), `buildInstructions`, `nodeVersion`, `stopApp`, `useBuildKit`, `tag` (`latest`; swarm: max numeric tag + 1), `privateRegistry`, `imagePrefix`.

Steps (`exec 2>&1; set -e`; `IMAGE=<imagePrefix><lc name>`):
1. `sudo docker pull <dockerImage>` (failure ignored).
2. If stopApp: `sudo docker stop <name> || true`. **Downtime starts here.**
3. `cd /opt/<name>/tmp; sudo rm -rf bundle; mkdir bundle`. BuildKit: `cp ./bundle.tar.gz ./bundle/bundle.tar.gz`. Otherwise: `sudo tar -xzf bundle.tar.gz; sudo chmod 777 ./ -R`.
4. `cd bundle`; write the Dockerfile:
   ```
   # syntax=docker/dockerfile:1-experimental
   FROM <dockerImage>
   RUN mkdir /built_app || true
   ARG <KEY>="<value>"            # one per app.env key (incl. VIRTUAL_HOST etc., NOT METEOR_SETTINGS/PORT)
   <buildInstructions lines>
   # BuildKit:
   RUN --mount=type=bind,target=/tmp/__mup-bundle tar -xzf /tmp/__mup-bundle/bundle.tar.gz -C /built_app --strip-components=1 && ls /built_app
   # else:
   COPY ./ /built_app
   RUN cd /built_app/programs/server && \
       npm install --unsafe-perm
   ```
5. `time sudo DOCKER_BUILDKIT=<0|1> docker build -t $IMAGE:build --build-arg "NODE_VERSION=<v>" .`. On failure: `docker start <name>`, exit 2.
6. `sudo rm -rf bundle` (relative to `tmp/bundle`, so effectively a no-op). If stopApp: `sudo docker start <name>` (the **old** container comes back up).
7. `sudo docker tag $IMAGE:latest $IMAGE:previous || true`; `sudo docker tag $IMAGE:build $IMAGE:<tag>`.
8. Registry: `docker push $IMAGE:previous || true`; `docker push $IMAGE:latest`.
9. `sudo docker image prune -f || true`. BuildKit: `sudo docker builder prune --keep-storage 2gb --force`.

Because the bundle COPY/extract comes before `npm install`, there is **no layer cache for npm install**: it runs fully on every deploy, on every server.

### 4.6 Local prepare-bundle (`docker.prepareBundleLocally`)

Requires `useBuildKit` (throws otherwise) and `privateDockerRegistry` (crashes otherwise).
1. `checkCompatible`: GET `https://<host>/v2`; a 401 with `WWW-Authenticate: Bearer` → use the registry API.
2. Write `<buildLocation>/Dockerfile`. Same as above, but `ARG` lines come from env, buildInstructions are **not** included, `npm install --unsafe-perm` is kept. Write `.dockerignore` = `*` and `!bundle.tar.gz`.
3. `docker login --username U --password P [host]`; `docker pull <image>`; `DOCKER_BUILDKIT=1 docker build -t <prefix>/mup-<name>:build . --build-arg NODE_VERSION=<v>` (cwd buildLocation). Note: the local image name uses `app.name` **without** lowercasing.
4. Retag:
   - API path: copy manifest `latest` → `previous` (GET `/v2/<img>/manifests/latest`, PUT `/manifests/previous`, accept `application/vnd.docker.distribution.manifest.v2+json`, Bearer token from the realm with basic auth; a 404 is ignored). Then `docker tag :build :latest; docker push :latest`.
   - Fallback: `docker pull :latest` (fails on the first deploy), `tag latest previous`, `tag build latest`, `push previous`, `push latest`.
5. Nothing is uploaded to the servers. Each server's start.sh pulls `:latest`.

### 4.7 `meteor.envconfig`: start.sh + env.list

`start.sh` vars:

| Var | Value |
|---|---|
| `imagePrefix` | `mup-` or `<imagePrefix>/mup-` |
| `appName` | `app.name` |
| `port` | `app.env.PORT \|\| 80`; per host `app.servers.<n>.env.PORT` |
| `bind` | `docker.bind \|\| '0.0.0.0'`; per host `app.servers.<n>.bind` |
| `sslConfig`, `logConfig`, `volumes`, `docker` | from config |
| `proxyConfig` | whole `proxy` object |
| `nginxClientUploadLimit` | `app.nginx.clientUploadLimit \|\| '10M'` |
| `privateRegistry` | registry config |

`env.list` content: `env = cloneDeep(app.env)` (after prepareConfig) + `METEOR_SETTINGS = JSON.stringify(settings)` + `PORT = docker.imagePort`. Per host: `lodash.merge` of `app.servers.<n>.env` (its `PORT` is skipped) and `METEOR_SETTINGS` from the per-host settings file.

Exact rendered format. Values are written raw: no quoting or escaping, so multi-line values break it. Docker strips the leading whitespace, and the later `ROOT_URL` overrides the first line.
```
ROOT_URL=http://localhost\n
\n
#it is possible to override above env-vars from the user-provided values\n
\n
  KEY=value\n
\n
  KEY2=value2\n
\n
```

### 4.8 `meteor.start` → `meteor-start.sh` → `config/start.sh` (series per server)

`meteor-start.sh` (`set -e`; `IMAGE=mup-<lc>`, **never prefixed**; `PRIVATE_REGISTRY` = `0` when a registry is configured):
1. Deploy with an image that does not support prepare-bundle → `sudo docker rmi $IMAGE:latest || true`.
2. `cd /opt/<name>`.
3. `if docker image inspect $IMAGE:latest || registry` → `sudo rm -rf current` (image mode).
4. Else (bundle mode): `rm -rf last; mv current last || true; mkdir current; cp tmp/bundle.tar.gz current/; docker rmi $IMAGE:previous || true`.
5. If `$IMAGE:previous` exists → `rm -rf last`.
6. `sudo bash config/start.sh`.

`config/start.sh` (rendered):
1. Choose the image.
   - No registry: `IMAGE=<prefix><lc>:latest`. If it does not exist → `IMAGE=<docker.image>` with `VOLUME=--volume=/opt/<name>/current:/bundle`; otherwise `VOLUME=""` and `LOCAL_IMAGE=true`.
   - Registry: `VOLUME=""`, `set -e; docker pull $IMAGE`.
2. Remove the old containers. **Downtime starts here.**
   - `docker rm -f <name>`.
   - `docker network disconnect bridge -f <name>`, plus each `docker.networks` entry.
   - Same rm/disconnect for `<name>-frontend`, `<name>-nginx-letsencrypt`, `<name>-nginx-proxy`.
3. In bundle mode (`LOCAL_IMAGE=false`): `docker pull <docker.image>` (failure ignored). This happens while the app is down.
4. Run the container:
   ```
   sudo docker run -d --restart=always $VOLUME \
     (--expose=<imagePort>            # if app.ssl.autogenerate OR (proxy && !proxy.loadBalancing)
      | --publish=$BIND:$PORT:<imagePort>) \
     --hostname="$HOSTNAME-<name>" --env-file=/opt/<name>/config/env.list \
     [--log-driver=<driver>] [--log-opt k=v ...] [-v host:container ...] [<docker.args raw> ...] \
     [legacy autogenerate: -e VIRTUAL_HOST=<d> -e LETSENCRYPT_HOST=<d> -e LETSENCRYPT_EMAIL=<e> -e HTTPS_METHOD=noredirect] \
     --name=<name> $IMAGE
   ```
5. Registry: `docker image prune -f`.
6. `sleep 3s` (image mode) or `sleep 15s` (bundle mode).
7. Legacy `app.ssl` blocks (§6.6).
8. `docker network connect <net> <name>` for each `docker.networks` entry.

### 4.9 Deploy check (`meteor-deploy-check.sh`, same series list, right after start)

Vars: `deployCheckWaitTime` = `app.deployCheckWaitTime || 60`; `deployCheckPort` = `docker.imagePort || 80` (**`app.deployCheckPort` is ignored**).

1. Host network detection: `docker inspect <name> --format "{{(index .NetworkSettings.Networks)}}" | grep -q '\[host'`.
2. Loop until `now >= start + wait`, sleeping 1 s each round:
   - IP = `localhost` (host network), else `.NetworkSettings.IPAddress`, else the first IP from `.NetworkSettings.Networks`.
   - No IP 10 times → revert.
   - `curl --max-time 25 --insecure --silent --show-error <IP>:<imagePort>` exits 0 on success. There is **no `--fail`**, so any HTTP status counts as success.
3. Timeout → revert, exit 1 → the whole command aborts and later servers are skipped.

Revert:
1. Print `docker inspect` state and `docker logs --tail=100`.
2. Registry: `docker pull $IMAGE:previous`.
3. If `$IMAGE:previous` exists: `docker tag previous latest`, [registry: `push latest`, `image prune`], `sudo bash start.sh`.
4. Elif `last/` exists: `mv last current` (bug: `current` exists, so this moves `last` *into* `current/`, and the legacy rollback restarts the new bundle), then `sudo bash start.sh`.

### 4.10 Versions, rollback, state

- Images kept: `:build` (newest build), `:latest` (running/desired), `:previous` (the latest before the last prepare). `docker image prune -f` removes dangling images. There is no explicit `mup rollback` command.
- **Dead code, never imported or executed:**
  - `plugins/meteor/rollback.js` (refers to a non-existent `utils.getVersions` and `/opt/<app>/config/version-history.txt`) and `plugins/meteor/state.js` (`deployingVersion`).
  - `assets/clean-versions.sh` (would `docker rmi <img>:<version>`), `assets/prepare-bundle-unsupported.sh`, `assets/start-swarm.sh`.
  - `plugins/proxy/graceful-shutdown.js` (uses a non-existent `api.expandServers`).
  - These are leftovers of a newer unreleased branch. Do not expect `version-history.txt` on MUP-1.5.11 servers.

---

## 5. Server-side layout MUP 1.5.11 leaves behind

### 5.1 Files / directories

| Path | Created by | Purpose / interop note |
|---|---|---|
| `/opt/<name>/` (`chown $USER -R`) | meteor setup | App root. The SSH user must own it for SFTP. |
| `/opt/<name>/config/start.sh` | envconfig | Container launcher. `mup start/restart` and the deploy-check revert run `sudo bash` on it. |
| `/opt/<name>/config/env.list` | envconfig | `--env-file`. |
| `/opt/<name>/config/bundle.crt`, `private.key` | proxy setup (custom certs) / legacy ssl | Cert sources (symlink targets). |
| `/opt/<name>/config/proxy-config-container.sh` | LB/swarm hook | Content-compared (`# VERSION=1`) → recreates `mup-proxy-configure-<name>` if it differs. |
| `/opt/<name>/config/{nginx.tmpl,nginx-default.conf,vhost.d/,html/}`, `/opt/<name>/certs/` | legacy `app.ssl.autogenerate` | Per-app legacy proxy. |
| `/opt/<name>/tmp/bundle.tar.gz` | push | Last uploaded bundle. Needed by bundle-mode `meteor-start.sh` (`mup start` without an image). |
| `/opt/<name>/tmp/bundle/` | prepare-bundle | Build context (`Dockerfile`, extracted bundle). Not reliably removed. |
| `/opt/<name>/current/bundle.tar.gz` | meteor-start (bundle mode) | Mounted `:/bundle`. Removed in image mode. |
| `/opt/<name>/last/` | meteor-start (bundle mode) | Previous `current`, used for revert. Removed when `:previous` exists. |
| `/opt/mongodb/` (`chown $USER`) | mongo setup | |
| `/opt/mongodb/mongo-start-new.sh` | mongo setup | Freshly rendered start script. |
| `/opt/mongodb/mongo-start-current.sh` | mongo start | Last applied script. Content-compared → recreates `mongodb` if it differs. |
| `/opt/mongodb/mongodb.conf` | mongo start script | `dbpath=/data/db` / `replSet=meteor`. |
| `/var/lib/mongodb` (or `mongo.dataPath`) | mongo start script | Mongo data. |
| `/opt/mup-nginx-proxy/{certs,mounted-certs,upstream,config,config/vhost.d,config/html,config/htpasswd}` | proxy-setup.sh (`chown $USER`; also mkdir+chown `/opt/<app>/config`) | Shared proxy. |
| `/opt/mup-nginx-proxy/config/{shared-config.sh,env.list,env_letsencrypt.list}` | proxy-setup (touch) / reconfig-shared | Shared settings. |
| `/opt/mup-nginx-proxy/config/start.sh` | proxy setup | Proxy launcher. |
| `/opt/mup-nginx-proxy/config/nginx.tmpl` | proxy setup | MUP's docker-gen template (`# V=1`). |
| `/opt/mup-nginx-proxy/config/nginx-shared.tmpl` | reconfig-shared (`templatePath`) | Overrides nginx.tmpl if present. |
| `/opt/mup-nginx-proxy/config/nginx-default.conf` | reconfig-shared / proxy start.sh | Mounted at `/etc/nginx/conf.d/my_proxy.conf`. start.sh appends `client_max_body_size …;` if it is not found by grep. |
| `/opt/mup-nginx-proxy/config/vhost.d/<domain>` | proxy setup | `client_max_body_size <limit>;` + nginxServerConfig. |
| `/opt/mup-nginx-proxy/config/vhost.d/<domain>_location` | proxy setup | nginxLocationConfig (deleted when unset). |
| `/opt/mup-nginx-proxy/config/vhost.d/<domain>_upstream` → `../upstream/<app>` | upstream.sh (LB) | Relative symlink, valid only inside the container. MUP finds an app's stale entries by deleting `upstream/<app>` and then `find . -xtype l -delete` inside the container. |
| `/opt/mup-nginx-proxy/upstream/<app>` | upstream.sh (LB) | `ip_hash;` (sticky) + `server <privateIp\|host>:<PORT>;` per app server. |
| `/opt/mup-nginx-proxy/certs/<domain>.crt\|.key` → `/opt/<app>/config/bundle.crt\|private.key` | ssl-setup.sh | Symlinks that mark cert ownership. Broken symlinks = certs of an app whose cert was deleted. |
| `/opt/mup-nginx-proxy/mounted-certs/<domain>.crt\|.key` | ssl-setup.sh (copies) + LE companion | Mounted at `/etc/nginx/certs`. LE also writes `*.chain.pem`, `default.crt`, etc. |

### 5.2 Containers

| Name | Image | Key flags |
|---|---|---|
| `<app.name>` (exact case) | `mup-<lc>:latest` / `<prefix>/mup-<lc>:latest` / `<docker.image>` (bundle) | `--restart=always`, `--hostname=$HOSTNAME-<name>`, `--env-file`, expose or publish (§4.8), default bridge, `--link=mongodb:mongodb` (built-in mongo), log `max-size=100m max-file=10` |
| `mongodb` | `mongo:<version>` | `--restart=unless-stopped --publish=127.0.0.1:27017:27017 --volume=<dataPath>:/data/db --volume=/opt/mongodb/mongodb.conf:/mongodb.conf --log-opt max-size=100m --log-opt max-file=7 --hostname mongodb`, cmd `mongod -f /mongodb.conf` |
| `mup-nginx-proxy` | `zodern/nginx-proxy:v1.1.0` | §6.2 |
| `mup-nginx-proxy-letsencrypt` | `jrcs/letsencrypt-nginx-proxy-companion:v1.13.1` | §6.2 |
| `mup-proxy-configure-<app>` | `busybox:1.28.4` (`tail -f /dev/null`) | LB/swarm only; `--restart=always`, carries `VIRTUAL_*` env |
| `mup-nginx-proxy-swarm-upstream` | `zodern/nginx-proxy-swarm-upstream` (untagged) | swarm only |
| `<name>-frontend` | `meteorhacks/mup-frontend-server` | legacy `app.ssl` crt/key |
| `<name>-nginx-proxy`, `<name>-nginx-letsencrypt` | `zodern/nginx-proxy:v1.1.0`, `jrcs/…:v1.13.1` | legacy `app.ssl.autogenerate` |
| `<name>-dummy-http-server-for-ssl-check` | `debian` | transient (legacy ssl verify) |
| `meteor-debug`, `meteor-debug-2` | `alpine/socat` | `mup meteor debug`; left running |

### 5.3 Images / tags

| Image | Tags | Notes |
|---|---|---|
| `mup-<lc name>` (no registry) | `build`, `latest`, `previous` | Swarm adds numeric tags `1,2,3…` (latest is not updated). |
| `<imagePrefix>/mup-<lc name>` | same, pushed `latest` + `previous` | meteor-start.sh / meteor-destroy.sh still check **unprefixed** `mup-<lc>` names. |
| base images | `docker.image`, `mongo:<v>`, `zodern/nginx-proxy:v1.1.0`, `jrcs/letsencrypt-nginx-proxy-companion:v1.13.1`, `busybox:1.28.4` | |

### 5.4 Networks, labels, volumes

- Networks: everything on the default `bridge`. The overlay `mup-proxy` (`--attachable --driver overlay`; creation only succeeds in swarm, failures ignored) is joined by `mup-nginx-proxy` if it exists. User `docker.networks` are connected after run. Mongo connectivity is a legacy `--link`.
- Docker labels: **none** on containers/images. Swarm node labels: `mup-app-<name>=true` plus user `swarm.labels`.
- Named volumes: none. Bind mounts only (listed above). The LE companion uses `--volumes-from mup-nginx-proxy`.

### 5.5 What MUP inspects to decide behaviour (must stay consistent)

- `docker image inspect mup-<lc>:latest` → image vs bundle mode (meteor-start.sh, start.sh).
- `docker image inspect mup-<lc>:previous` → revert target; delete `last/`.
- `/opt/<name>/tmp/bundle.tar.gz` → bundle-mode start source.
- Container name `<name>` → `docker rm -f`, inspect, logs, deploy check (an IP is required unless on the host network).
- `/opt/mongodb/mongo-start-current.sh` vs `-new.sh` (byte compare via bash `==` on `cat` output) and `docker ps -q -f name=mongodb`.
- `/opt/<name>/config/proxy-config-container.sh` vs the new content, and `docker ps -q -f name=mup-proxy-configure-<name>`.
- `/opt/mup-nginx-proxy/config/nginx-default.conf` grep `client_max_body_size`; existence of `config/nginx-shared.tmpl`.
- Symlink conventions in `certs/` and `vhost.d/*_upstream` (used for cleanup).
- `docker network inspect mup-proxy`.
- To avoid spurious container recreation when switching tools: render the **original MIT templates with EJS 2.x and identical vars**, byte for byte.

---

## 6. Proxy

### 6.1 How an app registers

Only through container env vars, read by nginx-proxy's docker-gen through `/tmp/docker.sock`:

| Var | Value |
|---|---|
| `VIRTUAL_HOST` | `proxy.domains` (comma list) |
| `VIRTUAL_PORT` | `docker.imagePort` |
| `HTTPS_METHOD` | `redirect` if forceSSL, else `noredirect` |
| `LETSENCRYPT_HOST` / `LETSENCRYPT_EMAIL` | only with `letsEncryptEmail` |
| `HTTP_FORWARDED_COUNT` | `1` (unless set) |

- Non-LB: the app is `--expose`d only (no host port) on `bridge`; nginx reaches it by container IP.
- No per-app files are written on deploy. vhost.d, certs and upstream are only refreshed by `mup setup` / `mup proxy setup`.

### 6.2 Shared proxy containers (`/opt/mup-nginx-proxy/config/start.sh`, run with `sudo bash`)

1. `source config/shared-config.sh`; defaults `HTTP_PORT=80`, `HTTPS_PORT=443`, `CLIENT_UPLOAD_LIMIT=10M`.
2. Inline proxy-stop: rm -f both containers and disconnect them from bridge/mup-proxy.
3. Pull both images (failure ignored).
4. Append `client_max_body_size $CLIENT_UPLOAD_LIMIT;` to `nginx-default.conf` if it is missing.
5. Template = `nginx-shared.tmpl` if it exists, else `nginx.tmpl`.
6. `docker run -d -p $HTTP_PORT:80 -p $HTTPS_PORT:443 --name mup-nginx-proxy --env-file=config/env.list --restart=always --log-opt max-size=100m --log-opt max-file=7 --network bridge` with mounts:
   - `-v <tmpl>:/app/nginx.tmpl:ro`
   - `-v /opt/mup-nginx-proxy/mounted-certs:/etc/nginx/certs`
   - `-v …/config/vhost.d:/etc/nginx/vhost.d`
   - `-v …/config/html:/usr/share/nginx/html`
   - `-v …/config/htpasswd:/etc/nginx/htpasswd`
   - `-v …/config/nginx-default.conf:/etc/nginx/conf.d/my_proxy.conf:ro`
   - `-v /var/run/docker.sock:/tmp/docker.sock:ro`
   - `-v /opt/mup-nginx-proxy/upstream:/etc/nginx/upstream`
   - image `zodern/nginx-proxy:v1.1.0`
7. `sleep 2s`; `docker network connect mup-proxy mup-nginx-proxy` if that network exists.
8. `docker run -d --name mup-nginx-proxy-letsencrypt --env-file=config/env_letsencrypt.list --restart=always --volumes-from mup-nginx-proxy --log-opt max-size=100m --log-opt max-file=3 -v /var/run/docker.sock:/var/run/docker.sock:ro jrcs/letsencrypt-nginx-proxy-companion:v1.13.1`.
9. Swarm: also `mup-nginx-proxy-swarm-upstream`.

### 6.3 nginx.tmpl (`/app/nginx.tmpl`)

Based on jwilder nginx-proxy. MUP-specific parts:
- `upstream <host> { include /etc/nginx/vhost.d/<host>_upstream; }` is used when that file exists; otherwise container IP:port on shared networks.
- For swarm, the upstream uses the node IP + HostPort.
- Standard: `vhost.d/<host>` and `<host>_location` includes, htpasswd, `HTTPS_METHOD`/`HSTS`/`CERT_NAME`/`VIRTUAL_PROTO` support, `default.crt` 503 server, `DEFAULT_HOST`.

### 6.4 Custom certificates (`proxy.ssl.crt/key`, at setup)

1. `ssl-cleanup.sh`: rm `/opt/<app>/config/bundle.crt` + `private.key`; then in `/opt/mup-nginx-proxy/certs`, delete broken symlinks and their `../mounted-certs/` copies.
2. SFTP the new crt/key.
3. `ssl-setup.sh` per domain: `ln -s` into `certs/<d>.crt|.key` and `cp` into `mounted-certs/<d>.crt|.key`.

### 6.5 Load balancing / sticky sessions

- Host port = `app.env.PORT` or `randomSeed.create(app.name).intBetween(10000, 20000)`. Published on `<privateIp | docker.bind | 0.0.0.0>:<port>:<imagePort>`.
- `upstream.sh` (at proxy setup):
  1. `rm upstream/<app>`.
  2. `docker exec -w /etc/nginx/vhost.d/ mup-nginx-proxy find . -xtype l -delete`.
  3. If LB (non-swarm): write `upstream/<app>` = `ip_hash;` (unless `stickySessions:false`) + `server <privateIp|host>:<port>;` per app server, and symlink `vhost.d/<domain>_upstream` → `../upstream/<app>`.
  4. `docker exec mup-nginx-proxy nginx -s reload || true`.
- `service-configure.sh` (post `proxy.setup` and post `reconfig`, if LB or swarm):
  - Writes `/opt/<app>/config/proxy-config-container.sh`, which runs `busybox:1.28.4` named `mup-proxy-configure-<app>` with `-e VIRTUAL_PORT=<imagePort>`, `-e VIRTUAL_HOST`, `HTTPS_METHOD`, `LETSENCRYPT_HOST`, `PORT` (not `LETSENCRYPT_EMAIL`).
  - This gives proxy-only hosts a vhost.
  - Unquoted heredoc → `$` in values is expanded by bash.
- Graceful shutdown / draining: **not implemented** (graceful-shutdown.js is dead). Every server stays in the upstream during the rolling restart.

### 6.6 Legacy `app.ssl` (deprecated)

- **autogenerate**: in app start.sh,
  1. `wget https://raw.githubusercontent.com/jwilder/nginx-proxy/master/nginx.tmpl -O /opt/<name>/config/nginx.tmpl`.
  2. Write `nginx-default.conf` = `client_max_body_size <nginx.clientUploadLimit>;`.
  3. Run `<name>-nginx-proxy` (`-p 80:80 -p 443:443`, `DEFAULT_HOST`=first domain, mounts under `/opt/<name>/{config,certs}`), then `sleep 15s`.
  4. Run `<name>-nginx-letsencrypt`.
  5. The app gets `VIRTUAL_HOST`/`LETSENCRYPT_*`/`HTTPS_METHOD=noredirect` via `-e`.
- **crt/key**: `<name>-frontend` = `meteorhacks/mup-frontend-server /start.sh` with `--link=<name>:backend --publish=<bind>:<ssl.port>:443` and the cert mounts.

---

## 7. Mongo plugin

- Image `mongo:<mongo.version>` (default `3.4.24`), pulled with `set -e` (a pull failure aborts).
- Data `<dataPath|/var/lib/mongodb>:/data/db`. Config file `/opt/mongodb/mongodb.conf` (rewritten by every run of the start script) is mounted at `/mongodb.conf`: `dbpath=/data/db`, `replSet=meteor`.
- Start script (`/opt/mongodb/mongo-start-current.sh`):
  1. `mkdir -p <dataPath>`.
  2. `docker update --restart=no mongodb; docker exec mongodb mongod --shutdown; sleep 2; docker rm -f mongodb`.
  3. `docker run` (flags in §5.2).
  4. Replica set loop (max 20 × 1 s):
     ```
     <mongo|mongosh> --eval 'try {var c = rs.config();} catch (e){} if (c && c.members[0].host === "127.0.0.1:27017") { c.members[0].host = "mongodb:27017"; rs.reconfig(c);  } else { rs.initiate({_id: "meteor", members: [{_id: 0, host: "mongodb:27017"}]}) }'
     ```
- `mongo-start.sh`:
  1. Errors if `mongo-start-new.sh` is missing ("run mup mongo setup").
  2. Same content as `-current.sh` → only starts it if `docker ps -q -f name=mongodb` is empty.
  3. Different → copy new → current and run it (recreates the container; data persists).
- App side: `MONGO_URL=mongodb://mongodb:27017/<dbName>?replicaSet=meteor`, `--link=mongodb:mongodb`. Host access is only on `127.0.0.1:27017`.
- Constraint: exactly one app server, on the same host as `mongo.servers[0]`.

---

## 8. Docker plugin / server setup

`docker-setup.sh` on each unique host (parallel):
1. `hasDocker = sudo docker version | grep "version"`; server version via `--format '{{.Server.Version}}'`.
2. No docker, or major < 18 → `install_docker`:
   - `set +e`; `sudo rm /var/lib/dpkg/lock /var/cache/apt/archives/lock`; `sudo dpkg --configure -a`; `set -e`.
   - `sudo apt-get update`; `sudo apt-get -y install wget lxc iptables curl`.
   - `wget -qO- https://get.docker.com/ | sudo sh`; `sudo usermod -a -G docker ${USER}`.
   - `sudo service docker start || sudo service docker restart`.
3. Otherwise: `sudo service docker start || true`.
4. With a registry: `sudo docker login --password '<pw>' --username '<user>' <host>`.

Then the full `mup setup` continues: `meteor.setup` (dirs), mongo setup/start, proxy setup/start.

Supported distros:
- Anything with `apt-get` plus get.docker.com (Debian/Ubuntu family).
- `mup status` expects Ubuntu > 13, `apt-get` and bash as the default shell.
- Uses the `service` command, so it relies on the systemd compat wrapper.
- Non-root users need NOPASSWD sudo. Some commands call `docker` **without** sudo, which relies on the `usermod -aG docker` from setup:
  - `proxy-setup.sh`: `network inspect/create`
  - `upstream.sh`: `docker exec … find/reload`
  - `mongo-start.sh`: `docker ps`
  - `mongo shell/status`
  - `proxy nginx-config`
  - the first `docker exec` of `meteor debug`

---

## 9. Hooks and plugin API

### 9.1 Hooks

- Names: `pre.<plugin>.<commandKey>` / `post.<plugin>.<commandKey>`. A name with exactly one dot gets `default` inserted (`post.deploy` → `post.default.deploy`; `pre.setup` → `pre.default.setup`). They fire for nested `runCommand` calls too (e.g. `post.meteor.push`, `pre.meteor.prepareBundle`, `post.docker.setup`, `post.mongo.start`, `post.proxy.setup`).
- Forms:
  - a function → `{ method: fn }`
  - `{ localCommand: 'sh' }`: `child_process.execSync(cmd, { cwd: basePath, stdio: 'inherit' })`; failure → "Hook failed.", exit 1.
  - `{ method(api, nodemiral) }`: awaited; a throw → exit 1.
  - `{ remoteCommand: 'sh' }`: runs on **all** `config.servers` (ignores `--servers` and the plugin's servers) in parallel over fresh ssh2 connections. Output is printed per host after it finishes; errors are only logged.
  - Order within one object: localCommand → method → remoteCommand. Multiple handlers per name run in registration order: bundled plugins → config plugins → config `hooks`.
- Hooks can mutate state: the documented pattern `api.getSettings(); api.settings.X = …` in `pre.reconfig` works because settings and config are cached on the api instance. A drop-in needs a compatible `api` object if it wants to support function hooks.

### 9.2 Plugin loading

`config.plugins` entries are resolved in this order:
1. A path (starts with `.`, `/`, `~`) → relative to the config file dir.
2. `resolve-from(configPath)`.
3. `require.resolve` from mup.
4. `resolve-from(appPath)`.
5. The global modules dir.
6. The raw name.

Then `require`. Failure → red "Unable to load plugin", continue.

Module exports used:
- `name` (default: the package name) and `description`.
- `commands` (`{ key: { name?, description (false hides it), builder?(yargs), handler(api, nodemiral) } }`). Top-level CLI `mup <name> <cmd>`; the `default` plugin's commands are top-level.
- `hooks`.
- `validate` (`{ topLevelKey: (config, utils) => details[] }`). The docs say `validators`; the code reads `validate`.
- `prepareConfig(config, api)`, `scrubConfig(config, utils)`, `swarmOptions(config) → { labels?, managers? }`.

### 9.3 PluginAPI surface (`lib/plugin-api.js`)

Methods:
- Args and options: `getArgs()`, `getBasePath()`, `getVerbose()`, `getOptions()` (raw yargs argv).
- `hasMeteorPackage(name)` (bug: reads `config.meteor.path`).
- Config: `validateConfig(path, log)`, `getConfig(validate = true)`, `setConfig(c)`, `scrubConfig()`.
- Settings: `getSettings()`, `getSettingsFromPath(p)`.
- Execution: `runTaskList(list, sessions, opts{verbose, series, …})`, `runCommand(name)`.
- Server info: `getServerInfo(serverNames?, collectors?)` (cached docker info: `swarm`, `swarmNodes`, `swarmToken`, `images`), `serverInfoStale()`.
- Sessions: `getSessions(pluginKeys[])`, `getSessionsForServers(names[])`, `getManagerSession()`.
- Swarm: `swarmEnabled()`, `swarmInfo()`, `dockerServiceInfo(name)`.
- Private: `_normalizeConfig`, `_runHookScript`, `_runHooks`, `_runPreHooks`, `_runPostHooks`, `_commandErrorHandler`, `_pickSessions`, `_loadSessions`, `_cleanupSessions`.

Properties:
- `resolvePath(...p)` (path.resolve with `~`).
- `getDockerLogs(name, sessions, args, showHost)`, `runSSHCommand(serverOrSession, cmd) → { code, output, host }`, `forwardPort({…})`, `_createSSHOptions(server)`.
- `statusHelpers: { StatusDisplay, parseDockerInfo }`.
- `tasks: { addCreateService, addUpdateService, addCreateOrUpdateService, addStopService, addRestartService }`.
- `commandHistory`, `base`, `args`, `config`, `settings`, `sessions`, `configPath`, `settingsPath`, `verbose`, `program`, `profileTasks`, `validationErrors`.

Validation utils passed to validators: `VALIDATE_OPTIONS`, `improveErrors`, `addLocation`, `combineErrorDetails`, `serversExist`, `addDepreciation`.

---

## 10. Swarm (summary; out of scope)

- `swarm.enabled` → `docker setup` reconciles a cluster across **all** `servers`:
  - Managers = `proxy.servers` plus extras, aiming for an odd count (≥3 when there are ≥3 servers).
  - Steps: `docker swarm init --advertise-addr <host>`, `join --token`, `node promote/demote`, `node update --label-add/rm` (`mup-app-<name>=true` on app servers plus `swarm.labels`).
- App runs as a `docker service create`:
  - Image `mup-<lc>:<N>` (prepare-bundle tags `build` → N = max numeric tag + 1), env from createEnv, `--replicas=<#app servers>`, `--constraint node.labels.mup-app-<name>==true`.
  - `--endpoint-mode dnsrr` (with proxy) or vip + `--publish`, network `mup-proxy`, `--update-failure-action rollback`, parallelism ceil(n/3), delay 20s, hostname `{{.Node.Hostname}}-<name>-{{.Task.ID}}`.
  - `docker service update` diffs the env on later deploys.
- Proxy adds the `mup-nginx-proxy-swarm-upstream` container and the `SWARM_SERVICE` env on the configure container.
- `docker service logs` for logs; destroy is not supported.

---

## 11. Known slow points — `mup deploy` step by step

N = number of app servers (with `privateDockerRegistry`: steps 6–7 run on 1 server).

| # | Step | Where | Repeated | Mode | Cost notes |
|---|---|---|---|---|---|
| 0 | npm update check | local → npmjs.org | 1 per package | background | – |
| 1 | Load/normalise/validate config (done twice) | local | 2× | – | require + Joi |
| 2 | `pre.deploy` hooks | local / **all** servers | per hook | remote parallel | – |
| 3 | `getSettings` | local | 1 | – | – |
| 4 | `fs.rm(buildLocation)` | local | 1 | – | Removes the previous build → no incremental reuse |
| 5 | `meteor build --directory … --architecture os.linux.x86_64` | local | 1 | – | **Dominant cost** |
| 6 | tar + gzip **level 9** in node-tar (JS zlib) | local | 1 | – | Single-threaded, slow; skipped only by `--cached-build` |
| 7 | SSH connect (keepalive session) | each server | N | lazy | readyTimeout 60 s |
| 8 | SFTP upload `bundle.tar.gz` | each server | **N, sequential** | series | Full bundle every time, no delta |
| 9 | Read node version (full tar listing) | local | 1 | – | Decompresses the whole archive again |
| 10 | prepare-bundle.sh: `docker pull <base>` | each server | **N, sequential** | series | Network |
| 11 | prepare-bundle.sh: `docker stop <app>` → extract/copy → **`docker build` incl. `npm install --unsafe-perm`** (no layer cache) → `docker start <app>` (old) → tag → [push] → `image prune` → [`builder prune`] | each server | **N, sequential** | series | **Dominant remote cost**; app is DOWN during the build (default `stopAppDuringPrepareBundle: true`) |
| 12 | envconfig: SFTP `start.sh` + `env.list` | each server | N, sequential | series | Small |
| 13 | meteor-start.sh → start.sh: `rm -f` + 8 network disconnects/rm of legacy containers, [bundle mode: `docker pull <base>` while down], [registry: `docker pull` app image], `docker run`, **`sleep 3s`** (image) / **`sleep 15s`** (bundle) | each server | **N, sequential** | series | Second downtime window |
| 14 | meteor-deploy-check.sh: 1 s sleep + `docker inspect` + curl loop until any HTTP response (≤ `deployCheckWaitTime` 60 s; curl max 25 s) | each server | **N, sequential** (same list as 13 → rolling) | series | Meteor startup time |
| 15 | [LB/swarm] service-configure.sh | each proxy server | P, sequential | series | – |
| 16 | `post.deploy` hooks | local / all servers | per hook | – | – |

The four remote lists (8, 10–11, 12, 13–14) each walk the servers one at a time, and each finishes on all servers before the next list starts. Wall time ≈ local build + Σ over servers (upload + pull + build + configure + start + check). Steps 8, 10, 11 could run in parallel or once (registry) without changing server state. `mup setup` remote lists (docker, meteor dirs, proxy setup) run in parallel; `proxy.start` and mongo start are per host.

---

## 12. Quirks / bugs (decide consciously whether to replicate)

| Quirk | Effect |
|---|---|
| `--servers` split on space | The documented comma form selects nothing. |
| Validation is non-fatal | Configs with errors still deploy. Users may have "invalid" keys that work (`opts.*`, `ssl.upload`, `dockerImageFrontendServer`, `allowIncompatibleUpdate`). |
| `deployCheckPort`, `cleanAfterBuild`, `app.port`, `mongo.oplog/port`, `shared.nginxTemplate` | Accepted but ignored. |
| `allowIncompatibleUpdates` (schema) vs `allowIncompatibleUpdate` (code) | The flag never works with the documented key. |
| `cleanBuildLocation:false` ignored unless `buildLocation` is set | – |
| `pem`, `--settings`, per-server settings, `shared.templatePath` relative to **cwd** | Others are relative to the config dir. |
| ROOT_URL http→https rewrite drops `:` | `http://a.com:3000` → `https://a.com3000`. |
| `escapeEnvQuotes` escapes only the first `"` | Dockerfile `ARG` lines. |
| env.list values unquoted/raw | Newlines break it. |
| Bundle-mode revert `mv last current` | Moves into `current/`, so the rollback is broken. |
| Deploy check has no `--fail` | A 500 counts as healthy. |
| Local prepare image name not lowercased | Remote is lowercased. |
| `proxy envconfig` command | Missing handler → crash. |
| `proxy.status` `certificateExpire.length` on an object | The cert list is never printed. |
| `hasMeteorPackage` uses `config.meteor.path` | Throws with an `app`-only config. |
| Mongo `shell` uses `app.name` | Not `mongo.dbName`. |
| busybox configure container lacks `LETSENCRYPT_EMAIL` | LE email comes from the app container. |

## Appendix: test vectors (computed with mup's bundled libs)

| Input | Output |
|---|---|
| LB port `app` | 19157 |
| LB port `myapp` | 18442 |
| LB port `staging` | 11399 |
| LB port `production` | 17499 |
| LB port `Wekan` | 10318 |
| buildLocation for appPath `/home/u/myapp` | `<tmpdir>/mup-meteor-b5af117c-b68e-49a5-ae1c-0877b574ddbb` |
| buildLocation for appPath `/Users/me/app` | `<tmpdir>/mup-meteor-3eaabbe3-e2b0-497d-8456-b27d10a37804` |

Algorithm:
```js
const rand = require('random-seed').create(absAppPath);
const n = [];
for (let i = 0; i < 16; i++) n.push(rand(255));
'mup-meteor-' + require('uuid').v4({ random: n });
// LB port:
require('random-seed').create(app.name).intBetween(10000, 20000);
```

Rendered `env.list` example (`{ ROOT_URL: 'https://a.com', PORT: 3000, METEOR_SETTINGS: '{"a":1}' }`):
`"ROOT_URL=http://localhost\n\n#it is possible to override above env-vars from the user-provided values\n\n  ROOT_URL=https://a.com\n\n  PORT=3000\n\n  METEOR_SETTINGS={\"a\":1}\n\n"`
