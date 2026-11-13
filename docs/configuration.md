# Configuration

[README](../README.md) · [Getting started](getting-started.md) · **Configuration** · [Commands](commands.md) · [How it works](how-it-works.md) · [Migrating from MUP](migrating-from-mup.md) · [Troubleshooting](troubleshooting.md)

comet-deploy reads the same config file as Meteor Up (MUP) 1.5.11: `mup.js` or `mup.json`, plus `settings.json`. This page lists every option comet-deploy reads, what it does with it, and the new `cometDeploy` section.

- [Config file](#config-file)
- [Paths](#paths)
- [Settings](#settings)
- [Validation](#validation)
- [`servers`](#servers)
- [`app` (or `meteor`)](#app-or-meteor)
  - [`app.servers`](#appservers)
  - [`app.env`](#appenv)
  - [`app.docker`](#appdocker)
  - [`app.buildOptions`](#appbuildoptions)
  - [Other `app` options](#other-app-options)
- [`mongo`](#mongo)
- [`proxy`](#proxy)
- [`privateDockerRegistry`](#privatedockerregistry)
- [Accepted but ignored](#accepted-but-ignored)
- [Rejected options](#rejected-options)
- [Planned for phase 2](#planned-for-phase-2)
- [Hooks](#hooks)
- [`cometDeploy`](#cometdeploy)
- [Environment variables](#environment-variables)
- [Full example](#full-example)

## Config file

comet-deploy looks for the config in this order:

1. `--config <path>` (a `.js` or `.json` file, relative to the current directory).
2. `./mup.js` in the current directory.
3. `./mup.json` in the current directory.

If none exists, it stops with `"mup.js" or "mup.json" not found in <dir>.` and the hint `Run "comet-deploy init" to create one, or pass --config <path>.`

`mup.js` is a CommonJS module that exports an object:

```js
module.exports = {
  servers: { /* ... */ },
  app: { /* ... */ },
};
```

The file is loaded fresh on every run. It can use `process.env` or `require()` like any Node module. It also works when it sits inside a package with `"type": "module"` (common for Meteor 3 apps): comet-deploy compiles it as CommonJS in that case.

`mup.json` holds the same object as plain JSON. MUP itself does not look for `mup.json` on its own; with MUP you have to pass `--config mup.json`.

The **base path** is the directory of `--config` when you pass it, otherwise the current directory. Relative paths in the config are resolved against it or against the current directory, as listed below.

## Paths

Same rules as MUP. `~` is expanded everywhere.

| Value | Relative to |
|---|---|
| `--config` | current directory |
| `--settings` | current directory |
| default `settings.json` | base path |
| `app.path` | base path |
| `servers.<name>.pem` | current directory; if the file is not there, the base path (with a warning) |
| `app.servers.<name>.settings` | current directory; if the file is not there, the base path (with a warning) |
| `app.buildOptions.buildLocation` | use an absolute path |

The fallback to the base path for `pem` and per-server `settings` is an addition: MUP only looks relative to the current directory. comet-deploy prints `"<path>" not found relative to the current directory; using <file> (relative to the config file).` when it uses the fallback.

## Settings

The Meteor settings file is `<base path>/settings.json` unless you pass `--settings <path>`. It must be strict JSON. comet-deploy loads it for `deploy`, `reconfig`, `meteor push`, `meteor build` and `meteor envconfig`. A missing file stops the command with `Settings file not found: <path>` and the hint `Create it or pass --settings <path>.`

The settings reach the app as the `METEOR_SETTINGS` environment variable: `JSON.stringify(settings)` on one line in `env.list`, exactly like MUP. A server can use its own settings file through [`app.servers.<name>.settings`](#appservers).

Settings are never part of the Docker image. Changing them does not need a new build: `comet-deploy reconfig` writes them to the servers and restarts the app.

## Validation

comet-deploy validates the config with the same Joi schemas as MUP 1.5.11 and reports problems with the same paths (for example `app.env.ROOT_URL`). The difference is what happens next.

| | MUP 1.5.11 | comet-deploy |
|---|---|---|
| `validate` command | exit 1 on any problem | exit 1 on any problem (errors and warnings) |
| Other commands | print the problems and continue | stop on **errors**, print **warnings** and continue |

**Errors** are problems that would break a deploy:

- `servers` is missing or empty; a server has no `host` or `username`; a `pem` path ends in `.pub`.
- The `app` (or `meteor`) section is missing; `name`, `path`, `servers` or `env.ROOT_URL` are missing or invalid. A config without any `env` is reported as `app.env.ROOT_URL is required`.
- `app.name` contains a space.
- `app.servers` names a server that is not defined in `servers`.
- An env value contains a newline (`env.list` cannot represent it).
- One of the [rejected options](#rejected-options) is set.
- A required key of `mongo`, `proxy.domains` or `privateDockerRegistry.host` is missing.
- Only one of `privateDockerRegistry.username` and `password` is set.
- A `cometDeploy` value is invalid, or `cometDeploy.transfer` does not fit `privateDockerRegistry` (see [`cometDeploy`](#cometdeploy)).

Everything else is a **warning**: unknown keys (for example a misspelled option), type differences that MUP tolerates in practice, and the [ignored options](#accepted-but-ignored). Keys in `servers.<name>.opts` are not checked at all: they all go to the SSH client.

Problems print as `<path> <message>`, for example:

```
Warning: app.docker.useBuildKit ignored: comet-deploy always builds locally with BuildKit
Error: cometDeploy.strategy must be one of [canary, rolling, parallel]
```

If your config uses a top-level `meteor` section instead of `app`, the paths start with `meteor.` instead.

`comet-deploy validate --show` prints the normalized config (with all defaults filled in). `--scrub` prints it with hosts, passwords, the app name and URLs replaced, the same way as `mup validate --scrub`. See [Commands](commands.md#validate).

## `servers`

The SSH targets. Each key is a server name you use in `app.servers` and in `--servers`.

```js
servers: {
  one: { host: '192.0.2.10', username: 'root', pem: '~/.ssh/id_ed25519' },
  two: { host: '192.0.2.11', username: 'deploy', password: 'secret', opts: { port: 2222 } },
  three: { host: '192.0.2.12', username: 'deploy' }, // ssh-agent
},
```

| Key | Type | Default | Description |
|---|---|---|---|
| `host` | string | required | Host name or IP address. |
| `username` | string | required | SSH user. `root`, or a user with passwordless `sudo` (see below). |
| `pem` | string | - | Path to the **private** key (not `.pub`). |
| `password` | string | - | SSH password. |
| `opts` | object | `{}` | Options for the SSH client. `port` (default `22`) is the documented one. All keys are passed to the [ssh2](https://github.com/mscdex/ssh2) client as they are, without a validation warning (MUP 1.5.11 warns about keys other than `port`). For example, `passphrase` decrypts an encrypted `pem` key, and `readyTimeout` changes the connection timeout. |
| `privateIp` | string | - | The address the proxy's load balancing upstream uses for this server instead of `host` (see [`proxy`](#proxy)). |

**Authentication** works like MUP: `pem` first, then `password`, then the ssh agent from `SSH_AUTH_SOCK`. If none is available, the command stops with `No SSH authentication for server "<name>" (<host>).`

**sudo.** Every remote command runs through `sudo`, as in MUP. The SSH user must be `root` or have passwordless sudo, and `sudo` must be installed on the server. Preflight checks this and stops with a clear message if sudo asks for a password or is missing.

**SSH connection defaults**: ready timeout 60 s, keepalive every 28 s, up to 12 missed keepalives. You can override these through `opts` (`readyTimeout`, `keepaliveInterval`, `keepaliveCountMax`).

**Host keys are not verified**, the same as MUP. See [Limitations](../README.md#limitations).

**Port forwarding.** comet-deploy sends the image through an SSH reverse tunnel, which needs TCP forwarding in `sshd` (`AllowTcpForwarding yes`, the OpenSSH default); only the changed layers travel. Preflight checks it on every server. A server that refuses it gets the whole image over SSH instead (with the default [`cometDeploy.transfer: 'auto'`](#cometdeploy)), which works but is slower. See [Troubleshooting](troubleshooting.md#allowtcpforwarding-is-disabled-on-the-server).

## `app` (or `meteor`)

The app to deploy. MUP accepts the section under `app` or under the older name `meteor`; comet-deploy does too, with the same rules (if `meteor` exists and `app` is not an object, `meteor` is used).

```js
app: {
  name: 'myapp',
  path: '../',
  servers: { one: {}, two: {} },
  env: { ROOT_URL: 'https://app.example.com', MONGO_URL: 'mongodb://db.example.com:27017/myapp' },
  docker: { image: 'zodern/meteor:root' },
  buildOptions: { serverOnly: true },
},
```

| Key | Type | Default | Description |
|---|---|---|---|
| `name` | string | required | App name. No spaces. It names the container (`<name>`), the directory `/opt/<name>` and the image `mup-<name in lower case>` on the servers, exactly like MUP. |
| `path` | string | required | Path to the Meteor app (the folder with `.meteor/`), relative to the base path. |
| `servers` | object | required | The servers to deploy to, with optional per-server values. See [`app.servers`](#appservers). The order of the keys is the rollout order (the first one is the canary). |
| `env` | object | required | Environment variables for the app. `ROOT_URL` is required inside it; without any `env` the error is `app.env.ROOT_URL is required`. See [`app.env`](#appenv). |
| `docker` | object | see below | Image and container options. See [`app.docker`](#appdocker). |
| `buildOptions` | object | see below | Options for `meteor build`. See [`app.buildOptions`](#appbuildoptions). |
| `deployCheckWaitTime` | number (seconds) | `60` | How long the health check waits for the app to answer after a start. |
| `deployCheckPort` | number | `docker.imagePort` | Port inside the container that the health check calls. MUP 1.5.11 ignores this option; comet-deploy uses it. |
| `log` | object | `{ opts: { 'max-size': '100m', 'max-file': 10 } }` | Docker logging: `driver` (`--log-driver`) and `opts` (`--log-opt key=value`). |
| `volumes` | object | - | Bind mounts: `{ '/host/path': '/container/path' }`, passed to `docker run -v`. |
| `type` | string | `'meteor'` | Set automatically. Only `meteor` apps are deployed. |
| `dockerImage` | string | - | Old MUP name for `docker.image`; moved there during normalization. |

### `app.servers`

Each key must be a server from `servers`. The value can be empty (`{}`) or hold per-server values:

```js
servers: {
  one: {},
  two: {
    env: { PORT: 8080, LOG_LEVEL: 'debug' },
    bind: '10.0.0.2',
    settings: './settings.two.json',
  },
},
```

| Key | Type | Description |
|---|---|---|
| `env` | object | Env variables for this server, merged over `app.env`. `env.PORT` here sets the published **host** port on this server; it is not written into `env.list`. |
| `bind` | string | Host address to publish the port on, for this server (overrides `docker.bind`). |
| `settings` | string | Path to a settings file for this server. Its JSON replaces `METEOR_SETTINGS` on this server. Relative to the current directory, with the fallback described in [Paths](#paths). Only the files of the servers a command targets must exist: with `--servers one`, a missing file of another server is no error. |

### `app.env`

Environment variables for the container. Values can be strings, numbers or booleans.

| Key | Description |
|---|---|
| `ROOT_URL` | Required. Must start with `http://` or `https://`. |
| `MONGO_URL` | Your MongoDB connection string. With a [`mongo`](#mongo) section it is replaced by the URL of MUP's built-in MongoDB. |
| `PORT` | The published **host** port (default `80`), as in MUP. Inside the container, `PORT` is always `docker.imagePort`. |
| anything else | Passed to the app as is. |

comet-deploy writes these into `/opt/<name>/config/env.list` in MUP's format: one `KEY=value` line each, no quoting, followed by `METEOR_SETTINGS` and `PORT`. Because of that format:

- A value with a newline is a validation error.
- A line longer than 64 KiB (in practice a very large `METEOR_SETTINGS`) stops the command before anything changes on the servers: `The env.list for server "<name>" has a METEOR_SETTINGS line of <n> KiB. Docker reads --env-file lines only up to 64 KiB, so the app could not start.` Docker itself cannot read longer lines, so MUP would fail at `docker run` with the same config.

Env values are never baked into the image (with one exception, see [`docker.buildInstructions`](#appdocker)). They are masked as `***` in all output, except the public keys `ROOT_URL`, `PORT`, `VIRTUAL_HOST`, `VIRTUAL_PORT`, `HTTPS_METHOD`, `HTTP_FORWARDED_COUNT`, `LETSENCRYPT_HOST` and `NODE_ENV`, and plain numbers or booleans.

### `app.docker`

| Key | Type | Default | Description |
|---|---|---|---|
| `image` | string | `'kadirahq/meteord'` | Base image. **Set this.** comet-deploy builds an app image on top of it, which needs an image with MUP's "prepare bundle" support: `zodern/meteor` (for example `zodern/meteor:root` or `zodern/meteor:latest`) or `abernix/meteord`. The default `kadirahq/meteord` only supports MUP's older bundle mode, which is [phase 2](#planned-for-phase-2). Any reference works, including a registry with a port (`registry.example.com:5000/org/image:tag`). |
| `prepareBundle` | boolean | `true` for `zodern/meteor*` and `abernix/meteord*`, otherwise `false` | Whether the image can build an app image. Set `true` to use another image that works like `zodern/meteor` (installs Node from the `NODE_VERSION` build argument and runs `/built_app`). `false` means bundle mode, which stops the deploy (phase 2). |
| `imagePort` | number | `3000` | Port the app listens on inside the container. |
| `bind` | string | `'0.0.0.0'` | Host address the port is published on (`--publish=<bind>:<PORT>:<imagePort>`). |
| `args` | string[] | - | Extra `docker run` arguments, inserted as they are. Example: `['--memory=1g', '-v /etc/timezone:/etc/timezone:ro']`. |
| `networks` | string[] | - | Docker networks the container is connected to after it starts. |
| `buildInstructions` | string[] | - | Dockerfile lines added right after `FROM`. comet-deploy always applies them, because it always builds an image. If a line references an `app.env` key as `$KEY`, `${KEY}` or with a modifier such as `${KEY:-default}`, that key becomes a build argument and comet-deploy warns `build args are visible in image history: KEY`. Changing its value triggers a new build. No other env value reaches the image. |
| `prepareBundleLocally` | boolean | - | Ignored, with a warning. comet-deploy always builds locally. |
| `useBuildKit` | boolean | - | Ignored, with a warning. comet-deploy always uses BuildKit. |
| `stopAppDuringPrepareBundle` | boolean | `true` | Ignored. There is no build on the server, so the app is never stopped for one. |
| `imageFrontendServer` | string | - | Rejected (deprecated MUP option). |

When the image name starts with `zodern/meteor`, the generated Dockerfile copies the app with `--chown=app:app`, so `npm install` can run as the image's `app` user.

### `app.buildOptions`

Options for the local `meteor build`, the same as MUP.

| Key | Type | Default | Description |
|---|---|---|---|
| `serverOnly` | boolean | - | Adds `--server-only`. Recommended unless you build mobile apps. |
| `debug` | boolean | - | Adds `--debug`. |
| `mobileSettings` | object | - | Adds `--mobile-settings <the object as JSON>`. Without it and without `serverOnly`, MUP's rule applies: `--mobile-settings <app path>/settings.json`. |
| `server` | string (URL) | - | Adds `--server <url>`. |
| `allowIncompatibleUpdates` | boolean | - | Adds `--allow-incompatible-update`. |
| `allowIncompatibleUpdate` | boolean | - | Same as above. MUP's schema documents the plural key but its code reads the singular one; comet-deploy accepts both. The singular key produces an "unknown property" warning, as in MUP. |
| `executable` | string | `'meteor'` | The Meteor command. Preflight checks that `<executable> --version` works. |
| `buildLocation` | string | `<tmp>/mup-meteor-<id>` | Output directory of `meteor build`. The default is stable per app path (the same value MUP computes). Use an absolute path if you set it. |
| `cleanBuildLocation` | boolean | `true` when `buildLocation` is not set | Deletes the build directory before each build. If you set `buildLocation`, it is only cleaned when you also set `cleanBuildLocation: true` (MUP behaviour). |
| `cleanAfterBuild` | boolean | - | Ignored. |

comet-deploy also sets `--architecture` per target platform (`os.linux.x86_64` or `os.linux.aarch64`, from the servers' CPU), where MUP always uses `os.linux.x86_64`. `meteor build` runs with `METEOR_HEADLESS=1`.

### Other `app` options

| Key | What happens |
|---|---|
| `enableUploadProgressBar` | Ignored. comet-deploy does not upload a bundle. |
| `port` | Ignored (MUP ignores it too). |
| `ssl`, `nginx` | Rejected, see below. |

## `mongo`

MUP's built-in MongoDB: one `mongo:<version>` container named `mongodb` on the app's server, a single-member replica set `meteor`, the data in a host directory. comet-deploy runs it with MUP 1.5.11's own scripts, so `/opt/mongodb`, the container and the data are the same as with MUP, and either tool can take over from the other.

```js
mongo: {
  version: '7.0.14',   // set it: MUP's default 3.4.24 is too old for Meteor 3
  servers: { one: {} },
  // dbName: 'myapp',          // default: app.name without dots
  // dataPath: '/var/lib/mongodb',
},
```

| Key | Default | Description |
|---|---|---|
| `servers` | required | The server MongoDB runs on. As in MUP, MongoDB is set up on every server listed, but the app uses only the first one; comet-deploy warns when there are more. |
| `version` | `'3.4.24'` (as MUP) | The tag of the `mongo` image. **Set it.** Meteor 3's MongoDB driver (6.16 in Meteor 3.5) works with MongoDB 4.0 to 8.0, so the default 3.4.24 cannot run a Meteor 3 app. Changing it on a server with data: see [Upgrading MongoDB](#upgrading-mongodb). |
| `dbName` | `app.name` without dots | The database the app uses (the path of `MONGO_URL`), and the one `mongo shell` opens. |
| `dataPath` | `/var/lib/mongodb` | The directory on the server that holds the data (mounted at `/data/db`). `mongo stop` and a new version keep it. |
| `oplog`, `port` | - | Accepted for MUP compatibility; MUP 1.5.11 does not use them either. |

What the section does, as in MUP:

- **`MONGO_URL` is replaced.** The app gets `MONGO_URL=mongodb://mongodb:27017/<dbName>?replicaSet=meteor` and the Docker option `--link=mongodb:mongodb`, whatever `app.env.MONGO_URL` says. `validate` warns when your `MONGO_URL` looks like an external database (`It looks like app.env.MONGO_URL is for an external database. Remove the \`mongo\` object to use external databases.`).
- **One app server, on the MongoDB server.** The link works only on the same machine, so the app must have exactly one server, and it must be the first `mongo.servers` server (same host and SSH port). Otherwise MUP skips its MongoDB without a word; comet-deploy warns in `validate` and `setup` says why (`MongoDB is not set up: MUP's built-in MongoDB needs exactly one app server (the app has 2). Use an external database: set app.env.MONGO_URL and remove the "mongo" section.`). For more servers, run your own MongoDB and remove the section.
- **`setup` starts it**, after Docker and the app directories and before the proxy. The [`mongo` commands](commands.md#mongo-commands) run each step on its own.

What comet-deploy adds:

- **The app commands check that MongoDB runs.** The app container cannot start without the `mongodb` container it is linked to, so `deploy` (in preflight, before the build), `reconfig`, `restart`, `rollback` and `start` stop before they touch the app: `Server "one": MongoDB (container "mongodb") is not running. Start it with: comet-deploy mongo start` (or `Set it up with: comet-deploy setup` when `mongo setup` never ran there). `stop` and `logs` do not check.
- **A version change the data cannot take is refused** before anything is written; see below.
- **The deploy lock.** `mongo setup`, `mongo start` and `mongo stop` take the app's deploy lock, so they do not run into a deploy.

### Upgrading MongoDB

MongoDB opens data written by the same release series (`7.0.x`) or by the series just before it, and only when that data's featureCompatibilityVersion (FCV) is the older series. The series are 3.0, 3.2, 3.4, 3.6, 4.0, 4.2, 4.4, 5.0, 6.0, 7.0, 8.0 ([MongoDB release notes](https://www.mongodb.com/docs/manual/release-notes/)). A version that skips a series or goes back would leave `mongod` restarting on the existing data. MUP does not check this; comet-deploy does, in `setup`, `mongo setup` and `mongo start`, against the version the container on the server was started with:

| Change | What comet-deploy does |
|---|---|
| Same series (`7.0.14` → `7.0.15`) | Recreates the container with the new image; the data stays. |
| The next series (`6.0.x` → `7.0.x`), FCV `6.0` | Recreates the container, then reminds you to raise the FCV before the next upgrade. |
| The next series, but the FCV is older or cannot be read (MongoDB stopped) | Refuses. For an older FCV the message has the command that sets it; when it cannot be read, start MongoDB with the old version first. |
| `3.2` → `3.4` | Recreates the container (3.2 has no FCV to check). |
| A skipped series (`5.0` → `7.0`) or an older series | Refuses. |
| A version that is not `major.minor[.patch]` of a known series (`latest`, `7`, `7.3`) | Warns that the change was not checked, and goes on as MUP would. |

To go from 5.0 to 7.0, upgrade one series at a time and raise the FCV after each step:

1. `version: '6.0.13'`, then `comet-deploy setup` (or `mongo setup` + `mongo start`).
2. `comet-deploy mongo shell`, then `db.adminCommand({ setFeatureCompatibilityVersion: "6.0" })`.
3. `version: '7.0.14'`, then `comet-deploy setup`.
4. `comet-deploy mongo shell`, then `db.adminCommand({ setFeatureCompatibilityVersion: "7.0", confirm: true })` (7.0 and later ask for `confirm: true`).

`mongo status` shows the FCV. `--allow-mongo-version-change` on `setup`, `mongo setup` and `mongo start` turns the check into a warning, for when you know better, for example with an empty `dataPath` that a backup will fill.

### Security

MUP's MongoDB has no user or password. Its port is published on `127.0.0.1:27017` only, so it cannot be reached from outside the server, but every process on the server can connect, and so can every container on Docker's default bridge network of that server. Do not use the built-in MongoDB on a server where you run code you do not trust; use your own MongoDB with authentication instead.

## `proxy`

MUP's reverse proxy: [nginx-proxy](https://github.com/nginx-proxy/nginx-proxy) in the container `mup-nginx-proxy` and the Let's Encrypt companion in `mup-nginx-proxy-letsencrypt`, one pair per server, shared by every app on that server. comet-deploy runs it with MUP 1.5.11's own scripts, templates and images, so the options, the files under `/opt/mup-nginx-proxy` and the containers are the same as with MUP. The section is validated and normalized exactly like MUP, including MUP's warning `app.env.PORT is ignored when using the reverse proxy`.

```js
proxy: {
  domains: 'app.example.com,www.app.example.com',
  ssl: {
    letsEncryptEmail: 'admin@example.com',  // or crt + key for your own certificate
    forceSSL: true,
  },
  clientUploadLimit: '20M',
  // loadBalancing: true,     // every proxy sends requests to all app servers
  // servers: { one: {} },    // where the proxy runs; default: the app servers
  // shared: { ... },         // settings of the proxy itself, for every app on the server
},
```

| Key | Default | Description |
|---|---|---|
| `domains` | required | Comma-separated domains. They become the app's `VIRTUAL_HOST` (and `LETSENCRYPT_HOST` with Let's Encrypt). |
| `ssl.letsEncryptEmail` | - | Get certificates for `domains` from Let's Encrypt. |
| `ssl.crt`, `ssl.key` | - | Your own certificate and key, paths relative to the config's directory. They are uploaded to the proxy servers. |
| `ssl.forceSSL` | `false` | Redirect `http://` to `https://` (`HTTPS_METHOD=redirect`). |
| `clientUploadLimit` | `'10M'` | nginx `client_max_body_size` for the app's domains. |
| `nginxServerConfig` | - | Path to a file with nginx directives for the `server` block of the app's domains (`vhost.d/<domain>`). |
| `nginxLocationConfig` | - | Path to a file with nginx directives for the app's `location /` block (`vhost.d/<domain>_location`). |
| `loadBalancing` | `false` | Every proxy server sends requests to all app servers through an nginx `upstream`. The app publishes `app.env.PORT` on each server; the upstream uses each server's `privateIp`, or `host` without one. |
| `stickySessions` | `true` | With `loadBalancing`: `ip_hash`, so a client stays on one server. |
| `servers` | the app servers | Where the proxy runs. |
| `shared` | - | Settings of the proxy containers themselves: `httpPort`, `httpsPort`, `nginxConfig`, `nginxTemplate`, `templatePath`, `env`, `envLetsEncrypt`. They apply to every app on the server. `proxy reconfig-shared` applies them; `deploy` never does. |

What comet-deploy does with it:

- `setup` sets the proxy up after Docker and the app directories, like `mup setup`. `comet-deploy proxy …` has MUP's proxy commands; see [Commands → `proxy` commands](commands.md#proxy-commands).
- `deploy` and `reconfig` also bring the app's proxy files up to date (MUP only does that in `setup`), without restarting the proxy containers.
- `deploy`, `reconfig`, `restart` and `rollback` replace the app container without a gap, and with `loadBalancing` take each server out of the upstream while it restarts. `cometDeploy.zeroDowntime: false` turns both off.
- Preflight stops before the build when the proxy is not running on a proxy server: `the reverse proxy is not set up (container mup-nginx-proxy is missing or stopped). Run "comet-deploy proxy setup" first.`
- Nothing that comet-deploy writes changes what MUP does next on the same servers.

How each of these works: [How it works → Behind the proxy](how-it-works.md#behind-the-proxy). The differences from MUP in one list: [Migrating from MUP](migrating-from-mup.md#the-reverse-proxy).

## `privateDockerRegistry`

MUP's private registry. comet-deploy builds the image on your machine as usual, pushes it to the registry, and every server pulls it from there. Use it when the servers should get the image from your registry instead of from your machine, for example when your uplink is slow and the servers are close to the registry.

```js
privateDockerRegistry: {
  host: 'registry.example.com',               // where docker login goes
  imagePrefix: 'registry.example.com/team',   // the image becomes registry.example.com/team/mup-<app>
  username: 'deploy',
  password: process.env.REGISTRY_PASSWORD,
},
```

| Key | Default | Description |
|---|---|---|
| `host` | required | The registry that `docker login` logs in to, on your machine and on the servers. |
| `imagePrefix` | - | Where the image goes: `<imagePrefix>/mup-<lowercase app name>`. `deploy`, `meteor deploy` and `meteor push` need it, and it must start with the registry in `host` (see below). |
| `username`, `password` | - | Set both or neither. With them, comet-deploy logs in on your machine, and `setup` and `docker setup` log the servers in. |

What comet-deploy does with it:

- **Login on your machine**, after preflight and before the build: `docker login --username <username> --password-stdin <host>`, so the password is never in a command line. Docker keeps the login (in `~/.docker/config.json` or your system's credential store) and replaces an earlier login to the same host. Without `username` and `password`, comet-deploy uses the login your Docker already has, for example from `docker login` in CI.
- **Push** of the version: `<imagePrefix>/mup-<app>:<version>`, or one tag per CPU architecture (`<version>-amd64`, `<version>-arm64`) when the servers differ. Nothing is pushed when every server has the version already. The local tags made for the push are removed again.
- **Pull on the servers.** Each server pulls its tag and keeps the image as `mup-<app>:<version>`, exactly as with the other transfers, so `rollback`, `history` and `status` work the same. The registry tag is removed on the server. The servers need a login to the registry: `setup` and `docker setup` run `docker login` there (MUP's script) when the config has `username` and `password`.
- **`:latest` for MUP.** After a deploy that ended healthy on every app server, `<imagePrefix>/mup-<app>:latest` in the registry points to the new version. MUP's `start.sh` pulls that tag (`mup reconfig`, `mup deploy`); comet-deploy never reads it. It is not changed by a deploy to only some app servers (`--servers`), by a deploy with several CPU architectures, or by `meteor push`, `rollback`, `reconfig` and `restart`. So after a `rollback` it still points to the newer version.
- **`start.sh` never pulls.** comet-deploy writes the same `start.sh` as without a registry: it runs `mup-<app>:latest` from the server's own Docker. MUP's `start.sh` with a registry pulls `:latest` from the registry on every start instead; see [How it works → Through a private registry](how-it-works.md#through-a-private-registry).
- **No clean-up in the registry.** Every deploy adds a version tag, and comet-deploy never deletes tags there. Use your registry's retention policy.
- **Trust.** Your Docker and the servers' Docker must accept the registry: a certificate they trust, or the registry in `insecure-registries` in `/etc/docker/daemon.json`. comet-deploy configures neither.

**`imagePrefix` and `host`.** Docker sends an image to the registry named in the first part of its name when that part contains a `.` or a `:` or is `localhost`, and to Docker Hub otherwise. `imagePrefix: 'team'` with `host: 'registry.example.com'` would therefore push your app to Docker Hub, so comet-deploy stops before preflight:

```
privateDockerRegistry.imagePrefix "team" would push to docker.io, not to the registry "registry.example.com" in privateDockerRegistry.host. Start it with the registry host, for example "registry.example.com/team".
```

For Docker Hub itself, use `host: 'docker.io'` (or `'https://index.docker.io/v1/'`) and `imagePrefix: '<your user>'`.

## Accepted but ignored

These options are valid MUP options. comet-deploy accepts them, so the same config keeps working with both tools, but they have no effect.

| Option | Message |
|---|---|
| `app.docker.prepareBundleLocally` | `Warning: app.docker.prepareBundleLocally ignored: comet-deploy always builds locally with BuildKit` |
| `app.docker.useBuildKit` | `Warning: app.docker.useBuildKit ignored: comet-deploy always builds locally with BuildKit` |
| `plugins` (non-empty) | `Warning: plugins MUP plugins are not supported by comet-deploy and will be ignored` |
| `app.docker.stopAppDuringPrepareBundle` | none |
| `app.enableUploadProgressBar` | none |
| `app.buildOptions.cleanAfterBuild` | none |
| `app.port` | none |

With a top-level `meteor` section, the paths in the messages start with `meteor.`.

## Rejected options

These stop every command that needs the config (and make `validate` exit 1):

| Option | Message |
|---|---|
| `app.ssl` | `app.ssl is a deprecated MUP option that comet-deploy does not support. MUP replaced it with the "proxy" section: move the domain and certificate settings there, or keep deploying this app with MUP.` |
| `app.nginx` | `app.nginx is a deprecated MUP option …` (same message) |
| `app.docker.imageFrontendServer` | `app.docker.imageFrontendServer is a deprecated MUP option …` (same message) |
| `app.dockerImageFrontendServer` | `app.dockerImageFrontendServer is a deprecated MUP option …` (same message) |
| `swarm.enabled: true` | `swarm.enabled Docker Swarm is not supported by comet-deploy` |

MUP deprecated `app.ssl`, `app.nginx` and `imageFrontendServer` in version 1.4 in favour of the [`proxy`](#proxy) section, which comet-deploy supports.

## Planned for phase 2

comet-deploy does not run MUP's bundle mode yet. A base image without app-image support (the default `kadirahq/meteord`, or `docker.prepareBundle: false`) stops the build with `The docker image "kadirahq/meteord" cannot build an app image (MUP bundle mode). Bundle mode is planned for phase 2 of comet-deploy.` and the hint `Use a zodern/meteor image (app.docker.image), e.g. "zodern/meteor:root".`

If your deploy depends on any of these, keep using MUP for now. Both tools can work on the same servers; see [Migrating from MUP](migrating-from-mup.md).

## Hooks

Hooks run your own commands before and after the steps of a command, as in MUP. A `hooks` section written for MUP works unchanged:

```js
hooks: {
  // Before the deploy, on your machine, in the config directory.
  'pre.deploy': {
    localCommand: 'npm test',
  },
  // After the deploy: on every server, and a function with MUP's api object.
  'post.deploy': {
    remoteCommand: 'docker image prune -f',
    async method(api) {
      const server = Object.values(api.getConfig().servers)[0];
      const r = await api.runSSHCommand(server, 'curl -fsS http://localhost/health');
      if (r.code !== 0) throw new Error(`health check failed on ${r.host}`);
    },
  },
  // A function alone is the same as { method: fn }.
  'pre.reconfig': (api) => {
    api.settings.public.deployedAt = new Date().toISOString();
  },
},
```

### Names

A hook name is `pre.<key>` or `post.<key>`, where the key is one of the steps in the [table below](#keys-and-nesting). A name with exactly one dot gets `default` in the middle, as in MUP: `pre.deploy` is `pre.default.deploy`. Hooks that end up under the same name run in the order of the config.

`validate` checks every hook:

| Problem | Severity |
|---|---|
| A value that is not an object with `localCommand`, `remoteCommand` or `method`, or a function | error: `must be an object with localCommand, remoteCommand or method, or a function` |
| `localCommand` or `remoteCommand` not a string, `method` not a function | error |
| Another property in the object | warning: `is an unknown property` |
| A name without `pre.` or `post.` | warning: `must start with "pre." or "post."` |
| A key that is not a step of MUP or comet-deploy, for example `pre.deplyo` | warning: `does not match a command, so it never runs` |
| A key of a command comet-deploy does not run (`default.init`, `default.validate`, `default.ssh`, `meteor.debug`, `docker.destroyCluster`, `proxy.envconfig`) | warning: `belongs to a command comet-deploy does not run (<key>), so it never runs` |

### The three forms

One hook object can have all three. They run in this order: `localCommand`, `method`, `remoteCommand`. If `localCommand` or `method` fails, the rest of the object and every later hook do not run.

**`localCommand`** runs on your machine with `/bin/sh -c`, in the config directory, with your environment. It can ask questions: stdin is the terminal. Its output is printed line by line, with secrets masked. Before it starts, comet-deploy prints `> Running hook pre.default.deploy "npm test"`. A non-zero exit fails the step:

```
Error: Hook "pre.default.deploy" failed: "npm test" exited with code 1.
```

**`remoteCommand`** runs on every server in `servers`, not only on the app servers, as in MUP. `--servers` narrows the list. It runs on all of them in parallel, without sudo, in the login shell of the SSH user. Before it starts, comet-deploy prints `> Running hook post.default.deploy remote command "…"`, then for each server `=> output from <host>` and the output. **A remote command that fails only warns, and the command goes on**, as in MUP:

```
Warning: Hook "post.default.deploy": the remote command exited with code 3 on server "one".
Warning: Hook "post.default.deploy": the remote command could not run on server "two": connect ECONNREFUSED
```

To make a check on a server stop the deploy, use a `localCommand` (for example `ssh deploy@203.0.113.10 /opt/check.sh`) or a `method` that checks the `code` of [`api.runSSHCommand`](#the-api-object) and throws.

**`method`** is a function. comet-deploy calls `await method(api, nodemiral)`. If it throws or its promise rejects, the step fails with `Hook "<name>" failed: <message>` (the stack trace with `--verbose`). The second argument is a placeholder: comet-deploy has no nodemiral, and any use of it throws `nodemiral is not available in comet-deploy. Use api.runSSHCommand(server, command) instead.`

### When hooks run and what a failure does

- A `pre.` hook runs right before its step. A `post.` hook runs right after the step succeeds. A nested step runs inside the outer one, so `pre.meteor.build` runs after `pre.default.deploy` and `post.default.deploy` last.
- **A failing hook fails its step.** After a failing `pre.` hook the step does not run. After a failing `post.` hook no later step runs.
- **When a step fails**, its `post.` hooks and those of the outer steps do not run, and the command exits with code 1 (130 after Ctrl+C). In the commands that start the app (`deploy`, `reconfig`, `restart`, `rollback`, `start`), a server that is not healthy at the end, or was skipped, counts as a failure of that step.
- **Clean-up always runs**: the deploy locks are released, the local registry is freed and a started proxy rollout is finished. The summary is printed if the activation ran.
- **The deploy history is written right after the activation**, before `post.meteor.start`, so a failing `post.` hook does not lose the record of the version the servers run. Old versions are not pruned after a failing `post.` hook; the next deploy does it.
- **Ctrl+C during a hook**: a `localCommand` gets the interrupt from the terminal and stops; a `method` and a `remoteCommand` are left to finish. Then comet-deploy stops at the next safe point, as without hooks.

A hook that changes the config (`api.getConfig().app.env.X = 'y'`, `api.setConfig(…)`) or the settings (`api.settings…`) changes what the later steps of the same command use. `deploy` and `reconfig` read the settings and the env at the activation, so a change in `pre.deploy` or `pre.reconfig` reaches the app. The files on disk do not change.

### Keys and nesting

`›` means the steps after it run inside the step before it, `→` means one after the other.

| Command | Keys |
|---|---|
| `deploy` | `default.deploy` › `meteor.deploy` › (`meteor.push` › `meteor.build` → `meteor.prepareBundle`) → (`default.reconfig` › `meteor.envconfig` → `meteor.start`) |
| `meteor deploy` | the same without `default.deploy` |
| `meteor push` | `meteor.push` › `meteor.build` → `meteor.prepareBundle` |
| `meteor build` | `meteor.build` |
| `reconfig` | `default.reconfig` › `meteor.envconfig` → `meteor.start` |
| `meteor envconfig` | `meteor.envconfig` |
| `restart`, `start`, `stop`, `logs` | `default.<command>` › `meteor.<command>` (the `meteor <command>` variants without `default.`) |
| `status` | `default.status` › `docker.status` → `meteor.status` → (with `mongo`) `mongo.status` → (with `proxy`) `proxy.status` |
| `setup` | `default.setup` › `docker.setup` → `meteor.setup` → (with `mongo`) `mongo.setup` → `mongo.start` → (with `proxy`) `proxy.setup` › `proxy.start` |
| `rollback` | `default.rollback` (comet-deploy only) |
| `meteor setup`, `meteor destroy` | `meteor.setup`, `meteor.destroy` |
| `docker setup`, `update`, `restart`, `ps`, `status` | `docker.<command>` |
| `mongo setup`, `start`, `stop`, `logs`, `shell`, `status` | `mongo.<command>` |
| `proxy setup` | `proxy.setup` › `proxy.start` |
| `proxy reconfig-shared` | `proxy.reconfigShared` › `proxy.start` |
| `proxy logs-le`, `nginx-config` | `proxy.leLogs`, `proxy.nginxConfig` |
| `proxy start`, `stop`, `logs`, `status` | `proxy.<command>` |

The keys are MUP's: a hook on any key runs at the same point with both tools, and `--show-hook-names` prints the same names. Where a hook lands differs from MUP in these places:

- **The deploy lock.** `deploy` takes the lock after `post.meteor.build` and before `pre.meteor.prepareBundle`, and releases it after `post.default.reconfig`. The hooks from `pre.meteor.prepareBundle` to `post.default.reconfig` run under the lock; `post.meteor.deploy` and `post.default.deploy` run after the unlock and the summary.
- **`meteor.prepareBundle`** is the distribution of the image to the servers (in MUP it builds the image on the server). It is the same point: the image is on the servers and the app still runs the old version.
- **`meteor.envconfig` in `deploy` and `reconfig`.** comet-deploy writes `env.list` and `start.sh` in the activation of each server, so that the canary and the revert work per server. `pre.meteor.envconfig` and `post.meteor.envconfig` therefore run right after each other, before the activation: a hook that reads `env.list` on a server in `post.meteor.envconfig` still sees the old file. The `meteor envconfig` command writes the files inside its step, as MUP does.
- **`meteor.start` in `deploy` and `reconfig`** is the whole activation by strategy: the start, the health check and the revert on every server. `post.meteor.start` runs once, after all servers.
- **`docker.status`** in `status` is an empty step: the Docker state is part of the app's table. It is there for the hooks.
- **`post.default.status`** runs after `proxy.status` has finished. MUP does not wait for `proxy.status` there, so its `post.default.status` hooks run while the proxy status is still being read.
- **`default.rollback`** is a comet-deploy command; MUP has no such key.
- The line before a `localCommand` always has the full name (`> Running hook pre.default.deploy …`); MUP leaves out `pre.`.

### The api object

The `api` argument of a method is the part of MUP's plugin API that works without MUP's nodemiral sessions. All hooks of one command get the same object.

| Member | What it does |
|---|---|
| `getArgs()`, `args` | The command words and the options you typed, without `--config`, `--settings`, `--servers`, `--verbose`, `--show-hook-names` and `--help`, as in MUP. |
| `getBasePath()`, `base` | The config directory. |
| `getVerbose()`, `verbose` | `--verbose`. |
| `getOptions()`, `program` | All options of the command. |
| `getConfig()`, `config` | The normalized config. It is live: a change applies to the steps that read the config later. |
| `setConfig(config)` | Replaces the config for the later steps, without validation, as in MUP. |
| `validateConfig()` | The problems of the current config as strings `"<path> <message>"`. |
| `scrubConfig()` | A copy of the config with the secrets hidden, as `validate --scrub`. |
| `getSettings()`, `settings` | The Meteor settings. Assigning `api.settings = {…}` replaces them for the later steps. |
| `getSettingsFromPath(path)` | Reads a JSON file with the same rules as `--settings`. |
| `runCommand(key)` | Runs the step of a key with its hooks, inside the running command (see below). |
| `runSSHCommand(server, command)` | Runs `command` on `server` and resolves with `{ code, output, host }` (stdout and stderr together). `server` is an object from `config.servers`; for one of them comet-deploy reuses its connection, for any other object it opens its own. It never throws for a non-zero exit: check `code`. |
| `resolvePath(...paths)` | `path.resolve` with `~` expanded. |
| `hasMeteorPackage(name)` | Whether `.meteor/versions` of the app (`app.path`) lists the package. |
| `swarmEnabled()` | Always `false`. |
| `commandHistory` | The keys entered so far, as `{ name }`, in order. |
| `configPath`, `settingsPath` | The paths of the config and the settings file. |

**`api.runCommand(key)`** runs the comet-deploy command behind a key, with the same config, settings and hooks, and only the global options (`--config`, `--settings`, `--servers`, `--verbose`, `--show-hook-names`). It throws:

- `Unknown command name: <key>` for a key MUP does not have, as MUP;
- `api.runCommand("<key>") is not supported by comet-deploy.` for `meteor.prepareBundle` (a distribution without a build), `meteor.debug`, `default.ssh` and the other keys comet-deploy does not run;
- for a command that takes the deploy lock (`deploy`, `reconfig`, `restart`, `rollback`, `setup`, `meteor deploy`, `meteor push`, `meteor restart`, `mongo setup`, `start` and `stop`, `proxy setup`, `reconfig-shared`, `start` and `stop`) called from a hook that runs under the lock of the running command: `api.runCommand("default.restart") cannot run while comet-deploy holds the deploy lock (from a hook inside a locked step). Run it from a post.default.deploy hook instead.`

These members need MUP's nodemiral sessions or Docker Swarm and throw `api.<name>() is not supported by comet-deploy (it needs MUP's nodemiral sessions). Use api.runSSHCommand(server, command) or a remoteCommand hook.`: `getSessions`, `getSessionsForServers`, `getManagerSession`, `runTaskList`, `getDockerLogs`, `getServerInfo`, `serverInfoStale`, `swarmInfo`, `dockerServiceInfo`, `forwardPort`, and everything in `api.tasks` and `api.statusHelpers`.

### `--show-hook-names`

Prints `Hook: pre.<key>` before each step and `Hook: post.<key>` after it succeeds, with the full name, also for nested steps. The command and its hooks run as usual.

The names are the same as MUP's, but MUP prints `Hook: post.default.<command>` (and in `deploy` also `Hook: post.default.reconfig`) right after the `pre.` line, before the nested steps: MUP does its own work for the command inside that hook, before the hooks of the config. comet-deploy prints the line where the hooks of your config run, after the nested steps. Your `post.default.<command>` hooks run last with both tools.

## `cometDeploy`

New options live in their own top-level section, so they never change the meaning of a MUP option. All keys are optional.

```js
cometDeploy: {
  strategy: 'canary',          // 'canary' | 'rolling' | 'parallel'
  transfer: 'auto',            // 'auto' | 'tunnel' | 'stream' | 'registry'
  platform: 'auto',            // 'auto' | 'linux/amd64' | 'linux/arm64'
  keepVersions: 5,             // version tags kept on each server for rollback
  zeroDowntime: true,          // behind the proxy: no gap on restart, drain with load balancing
  healthCheck: {
    path: '/',                 // must start with "/"
    maxStatus: 499,            // healthy = HTTP status <= maxStatus
  },
  lock: true,                  // deploy lock on the servers
},
```

| Key | Type | Default | Description |
|---|---|---|---|
| `strategy` | `'canary'` \| `'rolling'` \| `'parallel'` | `'canary'` | How servers are activated. `canary`: the first server alone, then the rest in parallel if it is healthy. `rolling`: one by one, stop at the first unhealthy server. `parallel`: all at once. Applies to `deploy`, `reconfig`, `restart` and `rollback`. The `--strategy` flag overrides it. See [How it works](how-it-works.md#rollout-strategies). |
| `transfer` | `'auto'` \| `'tunnel'` \| `'registry'` \| `'stream'` | `'auto'` | How the image reaches the servers; see the table below. With [`privateDockerRegistry`](#privatedockerregistry) it always goes through that registry. |
| `platform` | `'auto'` \| `'linux/amd64'` \| `'linux/arm64'` | `'auto'` | Target platform of the image. `auto` reads `uname -m` on each server (`x86_64`/`amd64` → `linux/amd64`, `aarch64`/`arm64` → `linux/arm64`) and builds once per platform found. A fixed value is used for all servers. |
| `keepVersions` | integer ≥ 1 | `5` | How many version tags stay on each server for `rollback`. Old tags are removed after a successful deploy. Versions that never ran healthy on that server are removed and do not count. The images behind `:latest` and `:previous` are never removed. |
| `zeroDowntime` | boolean | `true` | Behind the proxy (the `proxy` section), `deploy`, `reconfig`, `restart` and `rollback` replace the container without a gap; with `proxy.loadBalancing` they take each server out of the upstream while it restarts. `false` restarts the container in place, as MUP does. No effect without the proxy. See [How it works → Behind the proxy](how-it-works.md#behind-the-proxy). |
| `healthCheck.path` | string starting with `/` | `'/'` | Path the health check requests. |
| `healthCheck.maxStatus` | integer 100–599 | `499` | Highest HTTP status that counts as healthy. With the default, a 4xx counts as healthy (the app answers) and a 5xx does not. MUP accepts any HTTP answer, including 500. |
| `lock` | boolean | `true` | Take a lock on every target server before changing anything, so two deploys cannot run at the same time. `false` turns locking (and the lock check in preflight) off. |

**`transfer`** with `privateDockerRegistry`: `'auto'` and `'registry'` send the image through the registry to every server; `'tunnel'` and `'stream'` are config errors (`cometDeploy.transfer "tunnel" cannot be used with privateDockerRegistry: …`). `'registry'` without `privateDockerRegistry` is an error too.

Without `privateDockerRegistry`, `transfer` decides per server, from the forwarding check in preflight:

| `transfer` | Server allows SSH forwarding | Server refuses it (`AllowTcpForwarding no`) |
|---|---|---|
| `'auto'` (default) | tunnel | whole image over SSH, with a warning |
| `'tunnel'` | tunnel | preflight error |
| `'stream'` | whole image over SSH | whole image over SSH |

- **Tunnel:** the server pulls the image from a registry on your machine through an SSH reverse tunnel, so only the layers it does not have yet travel.
- **Whole image over SSH:** comet-deploy saves the image once per platform (`docker save`, gzip) into a private temporary file on your machine, and every server that does not have this version yet loads it with `sudo docker load`. The server ends with the same `mup-<app>:<version>` tag as through the tunnel, so `rollback` and `history` work the same. A server that has the version already gets nothing. The file is removed at the end of the deploy, also after an error or Ctrl+C.
- The local registry starts only when at least one server uses the tunnel.
- With `auto`, a tunnel that the server refuses only at distribution (after preflight passed) also switches that server to the whole image.

Related MUP options: the health check timeout is `app.deployCheckWaitTime` (default 60 s) and its port is `app.deployCheckPort` (default `app.docker.imagePort`).

Invalid values are errors (`cometDeploy.keepVersions must be greater than or equal to 1`); unknown keys inside `cometDeploy` are warnings.

**MUP and the `cometDeploy` key.** MUP 1.5.11 reports the unknown top-level key as a validation problem (`cometDeploy is an unknown property`) and continues, because MUP never stops a command on validation problems. Only `mup validate` exits with code 1 because of it. You can keep the section in a config you use with both tools.

## Environment variables

| Variable | Effect |
|---|---|
| `SSH_AUTH_SOCK` | ssh agent, used for servers without `pem` and `password`. |
| `XDG_CACHE_HOME` | Location of the local build cache: `$XDG_CACHE_HOME/comet-deploy/` (default `~/.cache/comet-deploy/`). |
| `TMPDIR` | Through Node's `os.tmpdir()`, the parent of the default `buildLocation`. |

`meteor build` runs with your environment plus `METEOR_HEADLESS=1`.

## Full example

A two-server app with an external MongoDB, per-server values and the `cometDeploy` section:

```js
module.exports = {
  servers: {
    one: {
      host: '192.0.2.10',
      username: 'deploy',
      pem: '~/.ssh/id_ed25519',
    },
    two: {
      host: '192.0.2.11',
      username: 'deploy',
      pem: '~/.ssh/id_ed25519',
      opts: { port: 2222 },
    },
  },

  app: {
    name: 'myapp',
    path: '../',

    servers: {
      one: {},
      two: {
        env: { PORT: 8080 },          // published on port 8080 on this server
        settings: './settings.two.json',
      },
    },

    buildOptions: {
      serverOnly: true,
    },

    env: {
      ROOT_URL: 'https://app.example.com',
      MONGO_URL: 'mongodb://myapp:secret@db.example.com:27017/myapp?authSource=admin',
      MONGO_OPLOG_URL: 'mongodb://oplog:secret@db.example.com:27017/local?authSource=admin',
    },

    docker: {
      image: 'zodern/meteor:root',
      args: ['-v /etc/timezone:/etc/timezone:ro', '-v /etc/localtime:/etc/localtime:ro'],
    },

    log: {
      opts: { 'max-size': '50m', 'max-file': 5 },
    },

    deployCheckWaitTime: 120,
  },

  cometDeploy: {
    strategy: 'canary',
    keepVersions: 5,
    healthCheck: { path: '/', maxStatus: 499 },
  },
};
```

The same config as `mup.json`:

```json
{
  "servers": {
    "one": { "host": "192.0.2.10", "username": "deploy", "pem": "~/.ssh/id_ed25519" }
  },
  "app": {
    "name": "myapp",
    "path": "../",
    "servers": { "one": {} },
    "buildOptions": { "serverOnly": true },
    "env": {
      "ROOT_URL": "https://app.example.com",
      "MONGO_URL": "mongodb://myapp:secret@db.example.com:27017/myapp?authSource=admin"
    },
    "docker": { "image": "zodern/meteor:root" }
  },
  "cometDeploy": { "strategy": "canary" }
}
```

For an `https://` `ROOT_URL`, add MUP's [`proxy`](#proxy) section with `ssl` (Let's Encrypt or your own certificate), or put your own reverse proxy or load balancer in front of the servers.
