# Migrating from Meteor Up

[README](../README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Commands](commands.md) · [How it works](how-it-works.md) · **Migrating from MUP** · [Troubleshooting](troubleshooting.md)

comet-deploy is a drop-in replacement for Meteor Up (MUP) 1.5.11. It reads the same `mup.js`, uses the same commands, and leaves the servers in the same state as MUP. You can switch an app over, and switch it back, without changing the servers.

- [In short](#in-short)
- [Check first: what does not work yet](#check-first-what-does-not-work-yet)
- [Step by step](#step-by-step)
- [Commands](#commands)
- [What stays the same](#what-stays-the-same)
- [What changes](#what-changes)
- [The reverse proxy](#the-reverse-proxy)
- [The built-in MongoDB](#the-built-in-mongodb)
- [MUP and comet-deploy side by side](#mup-and-comet-deploy-side-by-side)
- [Going back to MUP](#going-back-to-mup)
- [Differences at a glance](#differences-at-a-glance)

## In short

1. Install Docker with buildx on your machine. **This is new**: MUP does not need it.
2. Install comet-deploy.
3. In the folder with your `mup.js`, run `comet-deploy validate` and fix any errors.
4. Run `comet-deploy deploy`. No `setup` is needed on servers that MUP set up.

## Check first: what does not work yet

comet-deploy covers phase 1, MUP's reverse proxy and MUP's built-in MongoDB. If your config uses one of these, keep using MUP for that app for now:

| In your config | What comet-deploy does | What you can do |
|---|---|---|
| `privateDockerRegistry` | stop: `"privateDockerRegistry" is not supported yet …` | Keep MUP. |
| No `docker.image`, or `kadirahq/meteord`, or `docker.prepareBundle: false` (MUP bundle mode) | The build stops: `The docker image "kadirahq/meteord" cannot build an app image (MUP bundle mode).` | Set `docker.image: 'zodern/meteor:root'`. This is also the image in MUP's own `mup init` sample, so the config keeps working with MUP. |
| `swarm.enabled: true` | Error: `swarm.enabled Docker Swarm is not supported by comet-deploy` | Keep MUP. Swarm is not planned. |
| `app.ssl`, `app.nginx`, `app.docker.imageFrontendServer` (deprecated since MUP 1.4) | Error, for example `app.ssl is a deprecated MUP option that comet-deploy does not support. MUP replaced it with the "proxy" section: move the domain and certificate settings there, or keep deploying this app with MUP.` | Move the settings to the [`proxy`](configuration.md#proxy) section, which MUP uses too, or keep MUP. |
| `plugins` | Warning; the plugins do not run. | Make sure your deploy does not depend on them. |

**HTTPS.** With the `proxy` section, comet-deploy runs MUP's reverse proxy with Let's Encrypt or your own certificate; see [The reverse proxy](#the-reverse-proxy). Without it, comet-deploy publishes the app on a plain port (`app.env.PORT`, default 80), like MUP does without a proxy. If you terminate TLS in your own proxy or load balancer, nothing changes.

## Step by step

### 1. Prepare your machine

Install Docker with BuildKit and buildx: Docker Desktop, OrbStack, or Docker Engine on Linux. Check it:

```bash
docker buildx version
docker buildx inspect | grep Platforms
```

The list of platforms must include your servers' platform (usually `linux/amd64`). On an Apple Silicon Mac, enable emulation, see [Troubleshooting](troubleshooting.md#building-on-an-arm64-mac-for-amd64-servers).

You still need Meteor locally, as with MUP: `meteor build` runs on your machine in both tools.

Install comet-deploy: [Getting started → Install](getting-started.md#1-install-comet-deploy).

### 2. Validate the config

Run it in the folder where you run `mup`:

```bash
cd ~/code/myapp/.deploy
comet-deploy validate
```

comet-deploy uses MUP's validation rules and reports problems with the same paths. The difference: MUP prints problems and continues, comet-deploy stops on **errors** (problems that would break the deploy) and prints **warnings**.

Typical warnings on a MUP config, which you can leave as they are:

```
Warning: app.docker.useBuildKit ignored: comet-deploy always builds locally with BuildKit
Warning: app.docker.prepareBundleLocally ignored: comet-deploy always builds locally with BuildKit
```

`validate` itself exits with code 1 on warnings too, as `mup validate` does. `deploy` and the other commands only stop on errors.

The full list of errors and warnings: [Configuration → Validation](configuration.md#validation).

### 3. Check the servers

The server requirements are the ones MUP has:

- SSH user `root` or a user with passwordless sudo (same as MUP).
- Docker 18 or newer (MUP's `setup` installed it).
- `curl` on the server (MUP's deploy check uses it too).
- SSH TCP forwarding is recommended (`AllowTcpForwarding yes`, the OpenSSH default). comet-deploy sends the image through an SSH reverse tunnel, so only changed layers travel. A server that refuses it gets the whole image over SSH, with a warning. MUP uploads the bundle with SFTP and does not need it.

You do not have to check these by hand: the first step of every deploy (preflight) checks all of them on all servers and reports every problem before it builds anything.

### 4. Deploy

```bash
comet-deploy deploy
```

Do not run `comet-deploy setup` first on servers that MUP already set up. It is safe to run (it is MUP's own setup script), but it is not needed: comet-deploy uses the same `/opt/<name>` layout.

What to expect on the first deploy:

- The first local build runs the full `npm install` inside Docker. Later builds reuse that layer until your dependencies change.
- Each server pulls the base image (`docker.image`) from Docker Hub itself, then receives the app layers through the SSH tunnel. The first time this is the whole app; later only the changed layers.
- The image that MUP deployed becomes `mup-<name>:previous`. The new one is `mup-<name>:latest` and also `mup-<name>:<version>`.

### 5. Check the result

```bash
comet-deploy status
comet-deploy history
comet-deploy logs --tail 50
```

If something is wrong with the new version, `comet-deploy rollback` switches back to the version MUP deployed.

## Commands

The commands have the same names and the same options as in MUP.

| MUP 1.5.11 | comet-deploy | Notes |
|---|---|---|
| `mup init` | `comet-deploy init` | Same files, same rules for where they go. |
| `mup validate [--show] [--scrub]` | `comet-deploy validate [--show] [--scrub]` | Same output format for `--show` and `--scrub`. |
| `mup setup` | `comet-deploy setup` | Runs MUP's own setup scripts. Not needed on servers MUP set up. |
| `mup deploy [--cached-build]` | `comet-deploy deploy [--cached-build]` | New: `--strategy`, `--force-build`, `--force-unlock`. |
| `mup reconfig` | `comet-deploy reconfig` | Now with the lock, the rollout strategy and a history entry. |
| `mup restart`, `start`, `stop` | `comet-deploy restart`, `start`, `stop` | `restart` follows the rollout strategy. |
| `mup logs [docker logs options]` | `comet-deploy logs [options]` | Same: the options go to `docker logs`. |
| `mup status [--overview]` | `comet-deploy status [--overview]` | A one-line overview per server, then the MongoDB and proxy blocks. MUP's full status report is phase 2. |
| `mup meteor deploy`, `push`, `build`, `setup`, `envconfig`, `start`, `stop`, `restart`, `logs`, `status`, `destroy` | the same | Listed by `comet-deploy meteor --help`, not in the top-level help. |
| `mup docker setup`, `update`, `restart`, `ps`, `status` | the same | |
| `mup proxy setup`, `reconfig-shared`, `start`, `stop`, `logs`, `logs-le`, `nginx-config`, `status` | the same | `setup` and `reconfig-shared` restart the proxy only when its own files changed. `status` also lists drained servers. `proxy envconfig` fails, as in MUP. |
| `mup mongo setup`, `logs`, `start`, `stop`, `shell`, `status` | the same | `shell` opens the app's database (`dbName`). `setup`, `start` refuse a MongoDB version change the data cannot take. |
| `mup ssh`, `mup meteor debug` | exist, but print `… is not supported yet: it is planned for phase 2 of comet-deploy.` and exit 1 | Use MUP for these meanwhile; it works on the same config and servers. |
| - | `comet-deploy rollback [--to <version>]` | New. |
| - | `comet-deploy history` | New. |
| - | `comet-deploy unlock` | New. |

Global options are the same: `--config`, `--settings`, `--servers`, `--verbose`, `--show-hook-names`. Details: [Commands](commands.md).

## What stays the same

- **The config.** `mup.js` or `mup.json`, the `servers` and `app` (or `meteor`) sections, `settings.json`, the defaults, and the path rules. comet-deploy loads `./mup.js`, then `./mup.json`, or `--config`.
- **The server layout.** `/opt/<name>/config/start.sh` and `env.list`, the container `<name>`, the images `mup-<name>:latest` and `:previous`. `start.sh` is rendered from MUP 1.5.11's template with the same template engine, so it is the same file MUP writes.
- **The container.** Same `docker run` options: `--restart=always`, `--env-file`, the published port, the log options, `docker.args`, volumes, networks.
- **The scripts.** `setup`, `docker setup`, the proxy, starting, stopping and destroying the app use MUP's own shell scripts.
- **Settings and env.** `METEOR_SETTINGS` and the env variables reach the app exactly as with MUP, in the same `env.list` format.
- **SSH.** Authentication with `pem`, `password` or the ssh agent; `servers.<name>.opts.port`; sudo for every remote command.
- **The health check timeout.** `app.deployCheckWaitTime` (default 60 seconds).

## What changes

**Docker on your machine.** The image is built locally with `docker buildx`. MUP builds it on each server (unless you use `prepareBundleLocally` with a private registry).

**The app keeps running during the build.** MUP stops the app on a server while it builds the image there (`docker.stopAppDuringPrepareBundle`, `true` by default), so the downtime includes the build. comet-deploy builds on your machine and sends the image while the old version keeps running. The downtime per server is one container restart, and behind the proxy there is none. `stopAppDuringPrepareBundle` is ignored.

**SSH TCP forwarding.** The image travels through an SSH reverse tunnel when the server allows it (`AllowTcpForwarding yes`, the OpenSSH default). A server that does not, for example a hardened one, gets the whole image over SSH (`docker save` into `docker load`), which needs no change on the server but sends every layer on each new version. See [Troubleshooting](troubleshooting.md#allowtcpforwarding-is-disabled-on-the-server).

**Only changed layers travel.** The first deploy to a server sends the app's dependency layer once. After that, a code-only change sends only the small app-code layers. MUP uploads the whole bundle and runs `npm install` on every server for every deploy.

**All servers at once.** MUP deploys one server after another. comet-deploy distributes the image to all servers in parallel and then activates them by a rollout strategy: `canary` by default (the first server in `app.servers`, then the rest in parallel if it is healthy), or `rolling` or `parallel`. See [How it works → Rollout strategies](how-it-works.md#rollout-strategies).

**A stricter health check.** MUP accepts any HTTP answer, including a 500. comet-deploy counts a status up to 499 as healthy (`cometDeploy.healthCheck.maxStatus`), so a 5xx fails the deploy. A 4xx still passes. The path is configurable (`cometDeploy.healthCheck.path`). A container that stops or restarts fails the check at once instead of after the timeout.

**`deployCheckPort` is used.** MUP 1.5.11 accepts `app.deployCheckPort` but checks `docker.imagePort`. comet-deploy checks `deployCheckPort` when you set it. If you set it to a different port than the app listens on, remove it or fix it.

**A better automatic revert.** When the health check fails, MUP runs the `:previous` image with the new `start.sh` and `env.list`. comet-deploy restores the previous `start.sh`, `env.list` and image tags, starts the old version, and checks that it is healthy again.

**Validation errors stop the command.** MUP prints validation problems and continues. comet-deploy stops on errors, such as a missing `ROOT_URL` (or no `env` at all), a server in `app.servers` that is not in `servers`, or a `.pub` file as `pem`. In the other direction, comet-deploy accepts any SSH option in `servers.<name>.opts` (for example `passphrase`) without the warning MUP prints.

**`--servers` accepts commas.** `--servers one,two` and `--servers "one two"` both work. An unknown server name is an error. MUP splits on spaces only.

**Per-server CPU architecture.** comet-deploy reads `uname -m` on each server and builds for `linux/amd64` or `linux/arm64`, once per platform. MUP always builds the bundle for `os.linux.x86_64`.

**Env values stay out of the image.** MUP writes every `app.env` value into the generated Dockerfile as a build argument default, so they end up in the image metadata on the server. comet-deploy only passes the env keys that a `docker.buildInstructions` line references (`$KEY` or `${KEY}`), and warns about them.

**New files on the servers.** Version tags `mup-<name>:<version>`, `/opt/<name>/config/deploy-history.jsonl`, `/opt/<name>/config/.prev/` and, while a command runs, `/opt/<name>/config/deploy.lock/`. MUP ignores all of them. See [How it works → What is on the servers](how-it-works.md#what-is-on-the-servers).

**New local state.** Local images `mup-<name>:<version>` (the last 20 builds per app; older ones are removed), a stopped `comet-deploy-registry` container with a volume that is never cleaned up, and the build cache state in `~/.cache/comet-deploy/`.

## The reverse proxy

The `proxy` section works as in MUP: the same options, MUP's own scripts, templates and images (`zodern/nginx-proxy:v1.1.0`, `jrcs/letsencrypt-nginx-proxy-companion:v1.13.1`), the same files under `/opt/mup-nginx-proxy` and the same containers. An app that MUP deployed behind the proxy needs no `setup` before `comet-deploy deploy`. What changes:

- **`deploy` and `reconfig` update the app's proxy files.** MUP writes `vhost.d`, your own certificates and the load balancing upstream only in `setup` and `proxy setup`. comet-deploy brings them up to date on every `deploy` and `reconfig`, writes only what differs, and never restarts the proxy containers to do it.
- **The proxy restarts only when it has to.** `mup setup` and `mup proxy setup` always recreate the proxy containers, which interrupts every app on the server. comet-deploy's `setup`, `proxy setup` and `proxy reconfig-shared` recreate them only when the proxy's own files changed or it does not run. `proxy start` always recreates them, as in MUP.
- **No gap when the app restarts.** Without load balancing, `deploy`, `reconfig`, `restart` and `rollback` start the new container beside the old one and stop the old one only when nginx routes to the new one. The compromise: nginx can send part of the requests to the new version during its health check, so a version that answers with errors is seen briefly by some users.
- **Load balancing drains the server first.** With `loadBalancing`, a server is marked `down` in the upstream on every proxy before its app restarts, gets 5 s for the requests in flight, and goes back in after its health check. MUP keeps the server in the upstream, and the requests in flight on it fail. A server that does not end healthy stays out and is shown as `Drained:` by `status` and `proxy status`.
- **`mup proxy setup` clears the `down` marks** and so puts drained servers back in. comet-deploy's own `setup` and `proxy setup` keep them; `comet-deploy restart --servers <server>` puts a healthy server back.
- **`proxy setup` does not point the upstream at ports nothing listens on.** With load balancing, `mup setup` writes the config's upstream at once: turning load balancing on, or a new `PORT`, then fails every request until the next deploy. comet-deploy's `setup` and `proxy setup` leave those changes to the next `deploy`, which makes them server by server.
- **More locking.** With load balancing, `deploy`, `reconfig`, `restart` and `rollback` lock every app server, also with `--servers`. `setup` and the `proxy` commands that change the proxy take the app's lock too.
- **Preflight checks the proxy.** A deploy stops before the build when the proxy does not run on a proxy server (MUP would deploy an app that nobody can reach).
- **`proxy.shared` is applied only by `proxy reconfig-shared`**, as in MUP. A deploy warns when the app's `shared` section differs from the server.
- `cometDeploy.zeroDowntime: false` turns the gapless switch and the draining off.

Apps deployed by MUP and by comet-deploy can share the proxy on a server: comet-deploy changes only the files of the app it deploys. A `proxy start` or `reconfig-shared` of another app while this one switches is not locked out; the new proxy generates its config from the running containers, so the switch still works. MUP's proxy images were checked with Docker 27.5.1 and 29.9.3.

Details: [How it works → Behind the proxy](how-it-works.md#behind-the-proxy).

## The built-in MongoDB

The `mongo` section works as in MUP: MUP's own scripts, the same `/opt/mongodb` files (byte for byte), the same `mongodb` container, replica set `meteor` and `dataPath`, and the same `MONGO_URL` for the app. A server where MUP runs MongoDB needs no `setup` before `comet-deploy deploy`, and `mup mongo start` after `comet-deploy setup` finds `Same start script` and keeps the container. What changes:

- **The app commands check MongoDB first.** The app is linked to the `mongodb` container and cannot start without it. `deploy` stops in preflight, before the build, and `reconfig`, `restart`, `rollback` and `start` stop before they touch the app, with the command that fixes it. MUP would stop the app and fail to start it again.
- **A version change the data cannot take is refused.** MongoDB upgrades one release series at a time, with the featureCompatibilityVersion raised in between. MUP starts any `mongo.version`, and `mongod` then restarts forever on data it cannot open. comet-deploy refuses a skipped or an older series in `setup`, `mongo setup` and `mongo start`, before anything is written; `--allow-mongo-version-change` overrides it. See [Configuration → Upgrading MongoDB](configuration.md#upgrading-mongodb).
- **No silent skip.** When the app does not have exactly one server, on the MongoDB server, MUP's `setup` leaves MongoDB out without a word. comet-deploy warns in `validate` and says why in `setup`.
- **Restarting MongoDB on existing data works with MongoDB 6 and later.** MUP's start script creates the replica set with `rs.initiate` every time. With the `mongosh` shell of MongoDB 6+, that call fails on data that has the replica set already, so `mup mongo start` after `mongo stop`, or after a version change, reports `Failed connecting to mongo to create replica set` although MongoDB runs. comet-deploy runs the same script (it waits through the script's 20 retries), sees that the replica set `meteor` is up, and reports success.
- **`mongo start` with nothing to change does nothing.** MUP's script checks for a running MongoDB with `docker ps -f name=mongodb` without sudo. For an SSH user outside the `docker` group that check fails, and MUP recreates the MongoDB container on every `setup`; a container such as `mongodb-backup` makes it skip a stopped MongoDB. comet-deploy makes that decision with exact checks and then runs MUP's scripts, so the files on the server stay the same.
- **`mongo shell` opens the app's database** (`dbName`); MUP's opens the database named like `app.name`, which differs when the name has dots or `dbName` is set. It also works with piped input.
- **`mongo status` adds the featureCompatibilityVersion**, which the next upgrade needs, and `status` shows the MongoDB block like `mup status`.
- **The deploy lock.** `mongo setup`, `start` and `stop` take the app's lock.
- `mongo setup` does what MUP's does: it prepares the files and does not start MongoDB (MUP's help says "Installs and starts"). `setup` does both.

## MUP and comet-deploy side by side

Because the server state is the same, you can use both tools on the same app. The integration tests check this sequence against MUP 1.5.11: `mup setup` and `mup deploy`, then `comet-deploy deploy` without `setup`, then `mup restart` and `mup logs`, then `comet-deploy rollback` back to MUP's version, then `mup deploy` again.

Things to know:

- **Do not run both at the same time.** MUP does not know comet-deploy's lock.
- After a `mup deploy`, `comet-deploy status` shows `-` as the version, because `:latest` is not a comet-deploy version. `comet-deploy rollback` then picks the newest kept comet-deploy version.
- `mup deploy` moves `:latest` to `:previous` as usual. comet-deploy's version tags stay on the server.
- MUP 1.5.11 reports the `cometDeploy` section as `cometDeploy is an unknown property` and continues. Only `mup validate` exits with code 1 because of it.
- For the commands that are phase 2 in comet-deploy (`mup ssh`, `mup meteor debug`), use MUP on the same config.
- With the `mongo` section, both tools write the same MongoDB start script, so neither recreates the container the other one started. Mind the version: `mup setup` starts whatever `mongo.version` says, without comet-deploy's check.
- Behind the proxy, `mup proxy setup` clears the `down` marks of drained servers; see [The reverse proxy](#the-reverse-proxy).

## Going back to MUP

Nothing on the servers has to be undone. Run MUP again:

```bash
mup deploy
```

If your config is `mup.json`, pass it to MUP explicitly: `mup deploy --config mup.json` (MUP looks only for `mup.js` on its own).

Optional cleanup on each server (MUP ignores these, so you can also leave them):

```bash
ssh root@192.0.2.10
sudo docker images mup-myapp                       # list the tags
sudo docker rmi mup-myapp:20261111-091502-3f2a1c9  # remove version tags you do not need
sudo rm -rf /opt/myapp/config/.prev /opt/myapp/config/deploy-history.jsonl /opt/myapp/config/deploy.lock
```

`docker rmi` on a tag only removes the tag when `:latest` or `:previous` points to the same image.

On your machine, you can remove the local images `mup-myapp:<version>` and the local registry (see [Troubleshooting → Leftover local images](troubleshooting.md#leftover-local-images-and-the-registry-volume)).

## Differences at a glance

| | MUP 1.5.11 | comet-deploy 0.2.0 |
|---|---|---|
| Config | `mup.js` | the same `mup.js` (and `mup.json`), plus an optional `cometDeploy` section |
| Docker on your machine | not needed | required, with buildx |
| Where the image is built | on each server | once, on your machine |
| `npm install` | on every server, every deploy | cached; runs again only when the dependencies change |
| What is sent to a server | the whole bundle, with SFTP | only the missing image layers, through an SSH reverse tunnel |
| Order of servers | one after another | distribution in parallel; activation by strategy (`canary`, `rolling`, `parallel`) |
| App during the build | stopped by default | keeps running |
| Health check passes on | any HTTP answer | HTTP status ≤ 499 (configurable) |
| Health check port | `docker.imagePort` | `deployCheckPort`, default `docker.imagePort` |
| After a failed check | `:previous` image with the new config | previous image and previous config, checked again |
| Rollback command | - | `rollback`, `rollback --to <version>` |
| Deploy history | - | per server, `history` |
| Protection against two deploys at once | - | lock on each server |
| Validation problems | printed, the command continues | errors stop the command |
| `--servers` | space separated | space or comma separated |
| Server CPU | any (built on the server) | `x86_64` or `aarch64`, detected per server |
| Env values in the image | yes, as build argument defaults | only keys used in `buildInstructions` |
| SSH TCP forwarding | not needed | recommended: without it the whole image is sent over SSH |
| Reverse proxy (`proxy`) | supported | supported, with MUP's scripts and images |
| The app's proxy files | written by `setup` and `proxy setup` | also brought up to date by every `deploy` and `reconfig` |
| Proxy restart in `setup`, `proxy setup` | always | only when the proxy's own files changed |
| App restart behind the proxy | a gap while the container is recreated | no gap; with load balancing the server leaves the upstream first |
| Built-in MongoDB (`mongo`) | supported | supported, with MUP's scripts; checked before the app commands, version changes guarded |
| Hooks (`hooks`) | supported | supported, the same names; `remoteCommand` failures only warn in both; the api object without nodemiral sessions |
| Private registry, bundle mode | supported | phase 2 |
| Docker Swarm, MUP plugins | supported | not planned |
