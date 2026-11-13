# Commands

[README](../README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · **Commands** · [How it works](how-it-works.md) · [Migrating from MUP](migrating-from-mup.md) · [Troubleshooting](troubleshooting.md)

```
Usage: comet-deploy <command> [options]
```

The command names are the same as in Meteor Up (MUP) 1.5.11. Run commands from the directory that holds `mup.js` (or `mup.json`), or pass `--config`.

- [Global options](#global-options)
- [Exit codes and Ctrl+C](#exit-codes-and-ctrlc)
- [Output](#output)
- [Overview](#overview)
- Commands: [`init`](#init) · [`validate`](#validate) · [`setup`](#setup) · [`deploy`](#deploy) · [`reconfig`](#reconfig) · [`restart`](#restart) · [`start`](#start) · [`stop`](#stop) · [`logs`](#logs) · [`rollback`](#rollback) · [`history`](#history) · [`unlock`](#unlock) · [`status`](#status)
- Groups: [`meteor …`](#meteor-commands) · [`docker …`](#docker-commands) · [`mongo …`](#mongo-commands) · [`proxy …`](#proxy-commands)
- [Planned for phase 2](#planned-for-phase-2)

## Global options

These work with every command.

| Option | Description |
|---|---|
| `--config <path>` | Path to `mup.js` or `mup.json`, relative to the current directory. Default: `./mup.js`, then `./mup.json`. The directory of this file becomes the base path for relative paths in the config. |
| `--settings <path>` | Path to the Meteor settings file, relative to the current directory. Default: `settings.json` in the base path. |
| `--servers <names>` | Only these servers, by their names in `servers`. Space or comma separated: `--servers one,two` or `--servers "one two"`. An unknown name is an error (`Unknown server in --servers: <name>`). It filters the app servers for all app commands; `docker` and `proxy` commands filter their own server lists. |
| `--verbose` | Stream the output of remote commands and of the local `meteor build` and `docker buildx build`, line by line. |
| `--show-hook-names` | Print `Hook: pre.<key>` before each step and `Hook: post.<key>` after it, as MUP does. The command runs as usual. See [Configuration → Hooks](configuration.md#hooks). |
| `-v`, `--version` | Print the version (`0.3.0`). |
| `-h`, `--help` | Show help. `comet-deploy meteor --help` and `comet-deploy docker --help` list the commands of those groups; `--help` after a command (for example `comet-deploy meteor destroy --help`) shows its options. |

Without `--verbose`, remote output appears only when a step fails: the last 4200 characters of stderr and stdout, as in MUP. A failed local build shows its last lines (50 for `meteor build`, 60 for `docker buildx build`).

## Exit codes and Ctrl+C

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Any error: config not found or invalid, preflight failed, build failed, a server ended up not healthy (reverted, failed or skipped), an unknown command or option, a phase 2 command. `validate` also exits `1` when there are only warnings. |
| `130` | A rollout command was aborted with Ctrl+C (SIGINT) or SIGTERM. |

**Graceful abort.** `deploy`, `reconfig`, `restart`, `rollback` and their `meteor …` variants (including `meteor push` and `meteor build`) handle the first SIGINT or SIGTERM (Ctrl+C, or a cancelled CI job) like this:

1. They print `Aborting after the current step… (press Ctrl+C again to quit immediately)`.
2. The step that is running finishes. A server that is being activated finishes its health check (and its automatic revert, if needed). No further server is started.
3. The deploy history is written for the servers that were touched, the locks are released, and the local registry is stopped (unless another deploy on your machine still uses it).
4. The command ends with `Error: Deploy aborted` (or `Reconfig`, `Restart`, `Rollback aborted`), the hint `Servers that were not reached kept their previous state.`, and exit code `130`.

A second signal exits at once with code `130`. In that case the deploy lock can stay on the servers; release it with [`unlock`](#unlock).

If you press Ctrl+C in a terminal during the local build, `meteor build` or `docker buildx build` receive the signal too and stop. The command then ends with the build error (exit code `1`). Nothing has changed on the servers at that point.

Other commands (`logs -f`, `status`, `setup`, …) stop immediately on Ctrl+C.

## Output

- Phases print `==> Name` when they start and `<== Name (12.3s)` when they end (`<== Name failed (…)` on failure).
- Per-server steps print `[server] step <symbol> [detail]`. Symbols: `→` running, `✓` ok, `✗` failed, `↺` reverted, `-` skipped.
- Rollout commands end with a table: `SERVER  VERSION  RESULT  TIME  NOTE`.
- Colours are used only on a terminal (TTY). In CI the output is plain text.
- Secret values (env values, passwords, the SSH key passphrase, settings) are replaced with `***` everywhere, including error messages. Details: [Configuration](configuration.md#appenv).

## Overview

| Command | What it does | Servers | Lock | Strategy and health check | History entry |
|---|---|---|---|---|---|
| [`init`](#init) | Create `mup.js` and `settings.json` | - | - | - | - |
| [`validate`](#validate) | Check the config | - | - | - | - |
| [`setup`](#setup) | Install Docker, create app directories, set up MongoDB and the proxy | app (Docker: also `mongo`/`proxy` servers) | with `mongo` or `proxy` | - | - |
| [`deploy`](#deploy) | Build once, distribute, activate | app | yes | yes | yes |
| [`reconfig`](#reconfig) | Write env and settings, restart | app | yes | yes | yes |
| [`restart`](#restart) | Stop and start the app | app | yes | yes | yes |
| [`start`](#start) | Start the app | app, in parallel | - | health check only | - |
| [`stop`](#stop) | Stop the app | app, in parallel | - | - | - |
| [`logs`](#logs) | Show the app logs | app, in parallel | - | - | - |
| [`rollback`](#rollback) | Switch to an older kept version | app | yes | yes | yes |
| [`history`](#history) | Show who deployed what and when | app | - | - | reads it |
| [`unlock`](#unlock) | Release a stale deploy lock | app | releases | - | - |
| [`status`](#status) | Docker, container, version, HTTP, lock; MongoDB and proxy | app | - | - | - |
| [`meteor destroy`](#meteor-destroy) | Remove the app from the servers | app, one by one | - | - | deletes it |
| [`docker …`](#docker-commands) | Docker on the servers | see below | - | - | - |
| [`mongo …`](#mongo-commands) | MUP's built-in MongoDB | `mongo` servers | some | - | - |
| [`proxy …`](#proxy-commands) | MUP's reverse proxy | `proxy` servers | some | - | - |

---

## `init`

```
comet-deploy init [--json]
```

Creates `mup.js` (or `mup.json` with `--json`) and `settings.json` from MUP 1.5.11's sample. Existing files are not overwritten.

Where the files go follows `mup init`:

| You run it in | Files are created in | `app.path` in the sample |
|---|---|---|
| the Meteor app (has `.meteor/release`) | a new `.deploy/` folder inside the app | `'../'` |
| a folder whose parent is the Meteor app | the current folder | `'../'` |
| a folder next to the app, when the parent holds exactly these two | the current folder | `'../<app folder>'` |
| anywhere else | the current folder | `'./'` |

| Option | Description |
|---|---|
| `--json` | Write `mup.json` (plain JSON, no comments) instead of `mup.js`. |

The sample contains a `mongo` section for MUP's built-in MongoDB (`version: '4.4.12'`), which `setup` runs on the server. Keep it for an app with one server (a newer `version` such as `'7.0.14'` is a better start for a new app), or delete it and point `MONGO_URL` at your own database. See [Configuration → `mongo`](configuration.md#mongo) and [Getting started](getting-started.md#2-create-the-config).

## `validate`

```
comet-deploy validate [--show] [--scrub]
```

Loads, normalizes and validates the config, and prints every problem. Exits `1` on **any** problem, warnings included (like `mup validate`); prints `✓ Config is valid` otherwise.

| Option | Description |
|---|---|
| `--show` | Print the normalized config as JSON: defaults filled in, `meteor` moved to `app`, the `cometDeploy` defaults added. |
| `--scrub` | Same, with hosts, passwords, `pem` paths, the app name and URLs replaced (same output as `mup validate --scrub`). Safe to paste into an issue. |

`--show` prints the config as it is, secrets included. Use `--scrub` when you share it.

```bash
comet-deploy validate
comet-deploy validate --scrub > config-for-issue.json
```

What counts as an error and what as a warning: [Configuration → Validation](configuration.md#validation).

## `setup`

```
comet-deploy setup [--servers <names>] [--allow-mongo-version-change]
```

Prepares the servers, like `mup setup`:

1. **Docker setup** on every machine of the app servers (and of the `mongo` and `proxy` servers, if those sections exist), in parallel. It runs MUP's `docker-setup.sh`: if Docker is missing or older than 18, it installs it with `get.docker.com` (apt-based systems, Debian or Ubuntu) and adds the SSH user to the `docker` group; otherwise it starts Docker. A machine that appears twice (same host and SSH port) is set up once.
2. **App setup** on the app servers, in parallel: creates `/opt/<name>/`, `/opt/<name>/config` and `/opt/<name>/tmp` and gives them to the SSH user.

3. **MongoDB**, if the config has a `mongo` section: [`mongo setup`](#mongo-commands), then `mongo start`, as in MUP. A version change that the data cannot take stops `setup` here, before the start script is written (`--allow-mongo-version-change` turns that into a warning; see [Upgrading MongoDB](configuration.md#upgrading-mongodb)). When the config cannot run MUP's MongoDB (the app has more than one server, or not the MongoDB server), `setup` says why and goes on with the proxy.
4. **Proxy setup**, if the config has a `proxy` section: the same as [`proxy setup`](#proxy-commands), on the proxy servers.

Steps 3 and 4 take the deploy lock on the app servers while they run.

Servers that MUP has already set up do not need `setup` again.

```bash
comet-deploy setup
comet-deploy setup --servers two
```

## `deploy`

```
comet-deploy deploy [--strategy canary|rolling|parallel] [--cached-build | --force-build] [--cache-from <spec>] [--cache-to <spec>] [--force-unlock]
```

Builds the app once on your machine and deploys it to the app servers:

1. **Preflight**, local and on every server in parallel: local Docker, buildx and its platforms, the Meteor command; per server SSH, passwordless sudo, bash, Docker (version 18 or newer, running), CPU architecture, free disk space for Docker, the app directories from `setup` (`/opt/<name>/config`), SSH reverse port forwarding (a server without it gets the whole image over SSH; see [`cometDeploy.transfer`](configuration.md#cometdeploy)), and the deploy lock. All problems are reported at once, before anything is built.
2. **Build**, once per target platform: `meteor build`, then `docker buildx build` into `mup-<name>:<version>`. Skipped when nothing changed since a previous build (`No changes since <version>: reusing mup-<name>:<version>`).
3. **Lock** every target server.
4. **Distribute**: push to a local registry, then every server pulls only the layers it does not have, through an SSH reverse tunnel, in parallel. A server without SSH forwarding gets the whole image as a `docker save` archive over SSH instead, unless it has this version already. The running app is not touched. If any server fails here, the deploy stops and no server is changed.
5. **Activate** by strategy: per server, save the current `start.sh` and `env.list`, retag the image, write the new files, restart the container and run the health check. A server that fails is reverted to its previous image and config.
6. Write the deploy history, remove old versions on the healthy servers, release the locks.

Hooks run around these steps under MUP's keys (`pre.deploy`, `pre.meteor.build`, `post.meteor.start`, …); see [Configuration → Hooks](configuration.md#keys-and-nesting) for where each one lands.

The full description is in [How it works](how-it-works.md).

**With MUP's MongoDB** (a `mongo` section), preflight also checks that the `mongodb` container runs on every app server, before the build: `Server "one": MongoDB (container "mongodb") is not running. Start it with: comet-deploy mongo start`.

**Behind the proxy** (a `proxy` section):

- Preflight also checks that the proxy runs on every proxy server, before the build.
- The app's proxy files (`vhost.d`, your own certificates, the load balancing upstream) are brought up to date: only what differs is written, and the proxy containers are not restarted. MUP does this only in `setup`.
- Without `loadBalancing`, each server switches without a gap: the new container starts beside the old one, and the old one stops only after the new one is healthy and nginx routes only to it.
- With `loadBalancing`, each server is taken out of the upstream on every proxy before its restart (`[<server>] drain ✓ out of load balancing`), gets 5 s for the requests in flight, and goes back in after its health check. A server that does not end healthy stays out, and the deploy says so. Load balancing also makes the lock cover every app server, even with `--servers`.
- `cometDeploy.zeroDowntime: false` turns the last two off.

Details: [How it works → Behind the proxy](how-it-works.md#behind-the-proxy).

| Option | Description |
|---|---|
| `--strategy <s>` | `canary`, `rolling` or `parallel`. Default: `cometDeploy.strategy` (`canary`). |
| `--cached-build` | Reuse the newest local build for each platform, even if the app changed. Fails with `Unable to use previous build for <platform>: no cached image found.` if there is none. |
| `--force-build` | Build even if nothing changed. |
| `--cache-from <spec>` | Import a BuildKit cache before the image build, as `docker buildx build --cache-from` (for example `type=gha,scope=myapp`). Repeatable. For a build machine without the cache of earlier builds, such as a CI runner: see [Deploying from CI](ci.md#the-build-cache-between-runs). |
| `--cache-to <spec>` | Export the build cache after the image build, as `docker buildx build --cache-to` (for example `type=gha,mode=max,scope=myapp`). Repeatable. Needs a builder that can export a cache. |
| `--force-unlock` | Release existing deploy locks first (prints who held them), then lock. |

`--cached-build` and `--force-build` cannot be used together.

```bash
comet-deploy deploy
comet-deploy deploy --strategy rolling
comet-deploy deploy --servers one          # only server "one"
comet-deploy deploy --config ../.deploy/mup.js --settings ../.deploy/settings.production.json
```

Example output (shortened):

```
==> Preflight
<== Preflight (2.1s)
==> Build
==> meteor build (linux/amd64)
<== meteor build (linux/amd64) (48.2s)
==> docker build (linux/amd64)
<== docker build (linux/amd64) (7.4s)
<== Build (57.3s)
==> Lock
<== Lock (0.5s)
==> Distribute
[one] distribute →
[two] distribute →
[one] distribute ✓ 2.6s
[two] distribute ✓ 2.9s
<== Distribute (4.8s)
==> Activate
[one] activate →
[one] health ✓ HTTP 200 after 5s
[two] activate →
[two] health ✓ HTTP 200 after 5s
<== Activate (19.6s)

SERVER  VERSION                  RESULT  TIME  NOTE
one     20261111-091502-3f2a1c9  ok      9.4s
two     20261111-091502-3f2a1c9  ok      9.2s

Deployed 20261111-091502-3f2a1c9 to one, two.
```

The version tag is `YYYYMMDD-HHMMSS-<git sha7>`, in UTC, with `-dirty` when the app's git work tree has uncommitted changes, and without the sha outside git.

If a server is not healthy, the command prints the last 100 log lines of that server, the table shows `reverted`, `failed` or `skipped`, and it exits `1` with `Deploy of <version> did not complete on: <servers>`. If some servers run the new version and others do not, it says so (`MIXED VERSIONS: …`) and tells you how to fix it. See [Troubleshooting](troubleshooting.md#mixed-versions-after-a-partial-failure).

## `reconfig`

```
comet-deploy reconfig [--strategy canary|rolling|parallel] [--force-unlock]
```

Writes `start.sh` and `env.list` from the current config and settings to the app servers and restarts the app, by strategy, with the health check. The image does not change. Use it after you change `env`, `settings.json`, `docker.args`, ports or volumes.

On a server that fails the health check, the previous `start.sh` and `env.list` are restored and the app is restarted with them. A history entry `reconfig` is written.

Behind the proxy, `reconfig` also brings the app's proxy files up to date and switches like [`deploy`](#deploy) (no gap, or out of load balancing while the server restarts).

```bash
comet-deploy reconfig
comet-deploy reconfig --settings settings.production.json --strategy rolling
```

| Option | Description |
|---|---|
| `--strategy <s>` | Rollout strategy. Default: `cometDeploy.strategy`. |
| `--force-unlock` | Release existing deploy locks first. |

## `restart`

```
comet-deploy restart [--strategy canary|rolling|parallel] [--force-unlock]
```

Stops and starts the app on each server by strategy (MUP's `meteor-stop.sh`, then `meteor-start.sh` with the files already on the server) and runs the health check. Nothing changes on the server, so there is nothing to revert; a server that does not come up is reported as failed, with its last log lines. A history entry `restart` is written.

Behind the proxy it switches like [`deploy`](#deploy), without a gap, or with `loadBalancing` out of load balancing while the server restarts. It does not change the proxy files: the upstream keeps each server's address and port, only the `down` mark of a restarting server changes. A server that is still out of load balancing after an interrupted deploy goes back in when `restart --servers <server>` finds it healthy.

| Option | Description |
|---|---|
| `--strategy <s>` | Rollout strategy. Default: `cometDeploy.strategy`. |
| `--force-unlock` | Release existing deploy locks first. |

## `start`

```
comet-deploy start
```

Starts the app on all app servers in parallel (MUP's `meteor-start.sh`, which runs `/opt/<name>/config/start.sh`) and runs the health check on each. No lock, no history. Exits `1` if a server does not become healthy. With a `mongo` section it first checks that MongoDB runs, like `reconfig`, `restart` and `rollback`, and starts nothing when it does not.

## `stop`

```
comet-deploy stop
```

Stops the app on all app servers in parallel with MUP's `meteor-stop.sh`. As in MUP, this removes the app container (`docker rm -f <name>`); `start` creates it again from `start.sh`. No lock, no history.

## `logs`

```
comet-deploy logs [docker logs options]
```

Runs `docker logs` for the app container on all app servers at once and prints every line prefixed with `[<host>]`, like MUP. Options that comet-deploy does not know are passed to `docker logs`.

```bash
comet-deploy logs --tail 100
comet-deploy logs -f --tail 50
comet-deploy logs --since 10m --timestamps
comet-deploy logs -f --servers one
```

`--config`, `--settings`, `--servers` and `--verbose` are comet-deploy options and are not passed through.

`logs -f` streams until you press Ctrl+C. The output is printed as it arrives and not kept in memory, so it can run for a long time.

## `rollback`

```
comet-deploy rollback [--to <version>] [--strategy canary|rolling|parallel] [--force-unlock]
```

Switches each server back to an older image that is still on it, by strategy, with the health check. Nothing is built or transferred, so it takes seconds. **Only the image changes: the current `start.sh` and `env.list` stay.** Old env files could bring back replaced passwords; to change the config, use `reconfig`.

Which version each server rolls back to:

| | Target |
|---|---|
| `--to <version>` | That version, if it is on the server. Otherwise the server fails with `Version <v> is not on this server. Available: <list>`. |
| no `--to` | The newest kept version that is older than the one that runs and that ran healthy on this server according to its deploy history. If the server's history names no version (it is empty, cannot be read, or holds only `reconfig` and `restart` entries), any older kept version qualifies. If the version that runs is not a comet-deploy version (MUP deployed in between), the newest kept version. |
| no kept version qualifies | `:previous` (for example on a server deployed only by MUP), by swapping `:latest` and `:previous`. |
| nothing at all | The server fails with `Nothing to roll back to: no older version and no :previous image on this server`. |

If the health check fails, the server goes back to the image that ran before the rollback. Running `rollback` again goes one more version back. Version names are listed by [`history`](#history).

Behind the proxy it switches like [`deploy`](#deploy), without a gap, or with `loadBalancing` out of load balancing while the server restarts. It does not change the proxy files: the upstream keeps each server's address and port.

At the end it prints `Rolled back one, two to <version>.`, or `Rolled back one, two to the versions listed above.` when the servers went back to different versions (the summary table shows the version per server).

```bash
comet-deploy rollback
comet-deploy rollback --to 20261110-162233-8be41d0
comet-deploy rollback --servers one,two
```

| Option | Description |
|---|---|
| `--to <version>` | Version to roll back to (see `comet-deploy history`). |
| `--strategy <s>` | Rollout strategy. Default: `cometDeploy.strategy`. |
| `--force-unlock` | Release existing deploy locks first. |

How many versions are kept is set by [`cometDeploy.keepVersions`](configuration.md#cometdeploy) (default 5).

## `history`

```
comet-deploy history [--limit <n>]
```

Reads `/opt/<name>/config/deploy-history.jsonl` from the app servers and shows one row per deploy, newest first.

| Option | Description |
|---|---|
| `--limit <n>` | Number of entries, a whole number of 1 or more. Default `20`. Anything else stops with `--limit must be a whole number of 1 or more`. |

```
TIME                 ACTION    VERSION                  RESULT                       DURATION  BY                 COMMIT              SERVERS
2026-11-11 09:15:02  deploy    20261111-091502-3f2a1c9  success                      41.2s     Jane Doe@laptop    3f2a1c9 main        one, two
2026-11-11 08:58:40  reconfig  -                        reverted                     1m12s     Jane Doe@laptop    3f2a1c9 main        one
2026-11-10 16:22:33  deploy    20261110-162233-8be41d0  success: one, reverted: two  1m35s     John Roe@build-01  8be41d0 main dirty  one, two
```

- `TIME` is in your local time zone; version tags use UTC.
- `ACTION`: `deploy`, `reconfig`, `restart` or `rollback`.
- `RESULT`: `success`, `failed` or `reverted`; listed per server when the servers differ.
- `BY`: your git `user.name` (or the OS user) and the machine's host name.
- `COMMIT`: short sha, branch, and `dirty` when the work tree had changes.
- `SERVERS`: the servers that reported this entry.

A server without history (for example one deployed only by MUP) adds nothing; if no server has any history, it prints `No deploy history on the selected servers.` A server that cannot be read is reported as a warning.

## `unlock`

```
comet-deploy unlock
```

Removes the deploy lock from the app servers and prints who held it. Use it when a deploy was killed (second Ctrl+C, a crash, a lost connection) and left a lock behind.

```
[one] unlock ✓ released (was held by Jane Doe@laptop ("deploy" since 2026-11-11T09:15:02.118Z))
[two] unlock - not locked
```

Make sure no deploy is running before you unlock. Instead of a separate `unlock`, you can add `--force-unlock` to `deploy`, `reconfig`, `restart` or `rollback`.

## `status`

```
comet-deploy status [--overview]
```

One SSH round trip per app server, in parallel:

```
SERVER  DOCKER  APP      VERSION                  HTTP  LOCK
one     27.5.1  running  20261111-091502-3f2a1c9  200
two     27.5.1  running  20261111-091502-3f2a1c9  200
```

| Column | Meaning |
|---|---|
| `DOCKER` | Docker server version, or `not-installed`, `not-running`, `unreachable` (SSH failed). |
| `APP` | The app container: `running`, `restarting`, `stopped` or `missing`. |
| `VERSION` | The version tag whose image `:latest` points to. `-` when `:latest` is not a comet-deploy version (for example after `mup deploy`). |
| `HTTP` | HTTP status of `healthCheck.path` on the container, when it runs. |
| `LOCK` | Who holds the deploy lock, if anyone. |

With a `mongo` section, the [`mongo status`](#mongo-commands) block follows the table, then with a `proxy` section the [`proxy status`](#proxy-commands) block, as in MUP:

```
=> MongoDB status
 - running on server 192.0.2.10
 - Restarted 0 times
 - Running since 2026-11-12T10:00:00.000Z
 - Version 7.0.14
 - Connections: 5
 - Storage Engine: wiredTiger
 - Feature compatibility: 7.0
```

`--overview` shortens the MongoDB block to its first line; the app table is always this overview.

---

## `meteor` commands

The `meteor` group has the same commands as in MUP. They are not listed in the top-level `--help`; `comet-deploy meteor --help` lists them.

| Command | Same as |
|---|---|
| `meteor deploy` | `deploy` (same options) |
| `meteor push` | `deploy` up to the end of the distribution: preflight, build, lock, distribute. The new version is on the servers as `mup-<name>:<version>`, but `:latest` and the running app do not change. No history entry. Same options as `deploy`. |
| `meteor build` | Preflight and local build only. It still connects to the servers to read their CPU architecture, but it does not check port forwarding, the app setup or the lock. No lock, nothing changes on the servers. Same options as `deploy`. |
| `meteor setup` | The app setup step of `setup` (directories only, no Docker). |
| `meteor envconfig` | Writes `start.sh` and `env.list` to the app servers without restarting the app (no lock, no health check, no history). The next `start` or `restart` uses them. |
| `meteor restart`, `meteor start`, `meteor stop`, `meteor logs`, `meteor status` | The top-level commands. |
| `meteor destroy --force` | See below. |

### `meteor destroy`

```
comet-deploy meteor destroy --force
```

Removes the app from the app servers. Without `--force` it only prints what it would do: `This removes "<name>", its config and all its images from the servers.` and exits `1`.

With `--force` it waits 5 seconds (`Destroying "<name>" on one, two in 5 seconds… (Ctrl+C to cancel)`), then server by server:

1. stops the app (MUP's `meteor-stop.sh`),
2. runs MUP's `meteor-destroy.sh`: removes `/opt/<name>/`, the `:latest`, `:previous` and `:build` images, and runs `docker image prune -f`,
3. removes comet-deploy's extras: all version tags, the deploy history, the lock and the config snapshot.

Docker itself and other apps stay.

## `docker` commands

| Command | What it does | Servers |
|---|---|---|
| `docker setup` | MUP's `docker-setup.sh`: install Docker if it is missing or older than 18, otherwise start it. | Unique machines of the app, `mongo` and `proxy` servers, in parallel |
| `docker update` | MUP's `docker-update.sh`: reinstall Docker with `get.docker.com`. | same |
| `docker restart` | `service docker restart`: restarts the Docker daemon, and with it every container on the machine. | same |
| `docker ps [options]` | `docker ps` with your options (for example `-a`), one machine after another; output prefixed `[<host>]`. | same |
| `docker status` | Docker server version per server. Marks a server with `✗` and the command to fix it when Docker is not installed, not running, older than 18, or the server cannot be reached; warns when the servers run different versions. It checks every server, then exits `1` with `Docker is not usable on: <servers>` if any of them failed. | All entries of `servers` |

`--servers` filters each list. `docker destroy-cluster` (hidden) only prints that Docker Swarm is not supported.

```bash
comet-deploy docker status
comet-deploy docker ps -a
comet-deploy docker setup --servers three
```

## `mongo` commands

The `mongo` group has MUP 1.5.11's mongo commands, in MUP's order. They need a [`mongo`](configuration.md#mongo) section and run on `mongo.servers` (`--servers` filters them); `mongo shell` and `mongo status` use the first one, as in MUP. `mongo setup`, `start` and `stop` take the deploy lock on the app's servers first.

| Command | What it does |
|---|---|
| `mongo setup [--allow-mongo-version-change]` | MUP's `mongo-setup.sh` (creates `/opt/mongodb`), then writes MUP's start script to `/opt/mongodb/mongo-start-new.sh`. It does not start MongoDB, as in MUP (whose help says "Installs and starts"): run `mongo start`, or `setup`, which does both. A version change the data cannot take is refused before the file is written ([Upgrading MongoDB](configuration.md#upgrading-mongodb)). |
| `mongo logs [options]` | `docker logs` of the `mongodb` container; options pass through (`-f`, `--tail 50`). |
| `mongo start [--allow-mongo-version-change]` | When `mongo-start-new.sh` is the script the container was started with (`mongo-start-current.sh`), it keeps a running container without running anything (`MongoDB is up to date (container kept)`), or runs the current script if the container does not run (`MongoDB started`). Otherwise it runs MUP's `mongo-start.sh`, which recreates the container from the new script and keeps the data (`MongoDB recreated: the start script changed (7.0.14 → 7.0.15)`). MongoDB must run afterwards, or the command fails. The version change is judged from the scripts on the server, which `mup mongo setup` may have written from another config. Without `mongo-start-new.sh` it stops with `Set it up with: comet-deploy mongo setup`. |
| `mongo stop` | MUP's `mongo-stop.sh`: shuts `mongod` down and removes the container. The data in `dataPath` stays. The app cannot work until `mongo start`. |
| `mongo shell` | Opens `mongosh` (`mongo` for MongoDB 5 and older) on the database `dbName` inside the container, over an interactive SSH session; with a terminal it gets a pseudo-terminal, and piped input works too (`echo 'db.items.countDocuments()' \| comet-deploy mongo shell`). The exit code is the shell's. MUP's `mongo shell` opens the database named like `app.name`, which is not `dbName` when the name has dots or `dbName` is set. |
| `mongo status [--overview]` | MUP's MongoDB status block: the container state, restarts, start time, version, connections and storage engine, plus the featureCompatibilityVersion. `--overview` prints the first line only. |

```bash
comet-deploy mongo status
comet-deploy mongo logs --tail 100 -f
comet-deploy mongo shell
```

The app commands that start the app container check first that MongoDB runs; see [Configuration → `mongo`](configuration.md#mongo).

## `proxy` commands

The `proxy` group has MUP 1.5.11's proxy commands. They need a `proxy` section in the config (see [Configuration → `proxy`](configuration.md#proxy)) and run on the proxy servers: `proxy.servers`, or the app servers without it. `--servers` filters that list. `proxy setup`, `reconfig-shared`, `start` and `stop` first take the deploy lock on the app's servers, so they never change the proxy in the middle of a deploy of this app; a server where the app is not set up yet has nothing to lock.

| Command | What it does |
|---|---|
| `proxy setup` | What `mup proxy setup` does, with MUP's scripts: `proxy-setup.sh`, the proxy's `start.sh` and `nginx.tmpl`, the app's `vhost.d` files, your own certificates, and with `loadBalancing` the app's upstream and its config container (`mup-proxy-configure-<app>`). The upstream is written only when its servers and ports already match the config: turning load balancing on, or a new `PORT` or address, waits for the next `deploy` (`[<server>] load balancing is turned on by the next "comet-deploy deploy", …`), because the running containers do not listen there yet. Turning load balancing off is refused while `proxy.servers` has servers without the app. Then the proxy containers are recreated, **only when** one of the files they are created from changed or they do not both run. Otherwise it prints `[<server>] proxy up to date` and regenerates the nginx config, so new or removed files of the app still take effect. Servers that are out of load balancing stay out (see [`deploy`](#deploy)). |
| `proxy reconfig-shared` | Uploads the `proxy.shared` settings one server after another (an empty `shared` resets them to MUP's defaults), then recreates the proxy containers where the files changed. The shared settings apply to every app on the server. |
| `proxy start` | Recreates both proxy containers, always, as MUP does (`proxy-start.sh`). The way to force a restart of the proxy. |
| `proxy stop` | Removes both proxy containers (MUP's `proxy-stop.sh`). Every app behind the proxy on that server is unreachable until `proxy start`. |
| `proxy logs [options]` | `docker logs` of `mup-nginx-proxy`; options pass through (`-f`, `--tail 50`). |
| `proxy logs-le [options]` | `docker logs` of `mup-nginx-proxy-letsencrypt`. As in MUP, it reads the app servers. |
| `proxy nginx-config` | Prints the generated `/etc/nginx/conf.d/default.conf` of each proxy server. |
| `proxy status` | MUP's `=> Reverse Proxy Status` block: both containers, the published ports and the expiry date of each certificate. comet-deploy adds the servers that are out of load balancing (`- Drained: <servers> (run "comet-deploy restart --servers <servers>" once they are healthy)`) and the app's proxy files that do not match the config (`- Out of sync: … (run "comet-deploy proxy setup" to sync)`; when load balancing still has to be turned on, `comet-deploy deploy`). |
| `proxy envconfig` | Fails, as it does in MUP: `"proxy envconfig" has no implementation in MUP 1.5.11 either: it is listed in its help, but running it fails.` |

```bash
comet-deploy proxy status
comet-deploy proxy logs --tail 100 -f
comet-deploy proxy reconfig-shared
```

A restart of the proxy containers (`proxy start`, and `proxy setup` or `reconfig-shared` when the proxy's own files changed) interrupts every app on the server for a moment. `deploy`, `reconfig`, `rollback` and `restart` never restart the proxy.

## Planned for phase 2

These MUP commands exist so that you get a clear answer instead of "Unknown argument". `ssh` is listed in `--help` with "(planned for phase 2)", `meteor debug` in `meteor --help`. They do not read the config or touch the servers, and exit `1`. The message quotes the words you typed:

| Command | Example message |
|---|---|
| `ssh [server] [command…]` | `"ssh one ls" is not supported yet: it is planned for phase 2 of comet-deploy.` |
| `meteor debug` | `"meteor debug" is not supported yet: it is planned for phase 2 of comet-deploy.` |

Each prints the hint `Meanwhile you can run this command with MUP on the same config and servers.` Not planned: Docker Swarm. See the [Roadmap](../README.md#roadmap).
