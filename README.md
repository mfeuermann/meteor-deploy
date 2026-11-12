# comet-deploy

Fast deploys for Meteor apps, compatible with Meteor Up (MUP) 1.5.11.

comet-deploy builds the Docker image of your app **once, on your machine**, and sends each server **only the image layers it does not have yet**, to all servers in parallel. It reads your existing `mup.js`, has the same commands, and leaves the servers in the same state as MUP. You can switch an app from MUP to comet-deploy and back without touching the servers.

**Status:** version 0.1.0: phase 1 of the [roadmap](#roadmap) and the first part of the next phase, MUP's reverse proxy. Install it with `npm install -g comet-deploy`. Tested with unit tests and with integration tests against MUP 1.5.11 on disposable test servers. Try it on a staging server first.

> **Important: comet-deploy needs Docker on your machine**, with BuildKit and buildx: Docker Desktop, OrbStack, or Docker Engine on Linux. This is new compared to MUP, which builds the image on each server. To build for `x86_64` servers on an Apple Silicon Mac, amd64 emulation must be on. See [Requirements](#requirements).

## Contents

- [Why](#why)
- [How it works](#how-it-works)
- [Features](#features)
- [Benchmark](#benchmark)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Commands](#commands)
- [Differences from MUP](#differences-from-mup)
- [Limitations](#limitations)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [Documentation](#documentation)
- [Development](#development)
- [Contributing](#contributing)
- [License and credits](#license-and-credits)

## Why

MUP 1.5.11 deploys one server after another. On each server it uploads the whole app bundle, runs `docker build` with a full `npm install`, and by default stops the app while it builds. A small code change costs the same as a full rebuild, and every extra server adds the same time again.

comet-deploy keeps what works in MUP (the config, the commands, the server layout) and changes how the image gets to the servers:

- `npm install` runs only when the dependencies change. Its layer comes from the Docker build cache otherwise.
- A code-only change sends only the small layers with the app code.
- All servers get the image in parallel, while the old version keeps running.
- The switch on each server is one container restart, followed by a health check and an automatic revert if the new version does not answer.

## How it works

```
  YOUR MACHINE                                      SERVERS
 +----------------------------------------+
 | 1. Preflight: Docker, buildx, Meteor,  |------>  SSH, sudo, Docker, CPU,
 |    and every server, all at once       |         disk, setup, forwarding, lock
 |                                        |
 | 2. Build (skipped if nothing changed)  |
 |    meteor build                        |
 |    docker buildx build                 |
 |      base image                        |
 |      npm install layer   <-- cached    |
 |      app code layers     <-- changed   |
 |                                        |
 | 3. Lock every server                   |
 |                                        |
 | 4. Distribute                          |         +-----------+  +-----------+
 |    local registry on 127.0.0.1  =======|==SSH===>|  one      |  |  two      |
 |    (missing layers only, in parallel)  | tunnel  | docker    |  | docker    |
 |                                        |         | pull      |  | pull      |
 | 5. Activate by strategy                |         +-----------+  +-----------+
 |    canary: "one" first, then the rest  |-------> retag, start.sh, health check
 |    failed check -> automatic revert    |         (old version kept for revert)
 |                                        |
 | 6. History, prune old versions, unlock |
 +----------------------------------------+
```

1. **Preflight** checks your machine and all servers in parallel and reports every problem before anything is built.
2. **Build.** `meteor build`, then `docker buildx build` with a generated Dockerfile that puts the inputs of `npm install` in their own layer. If no file of the app changed since an earlier build, the build is skipped.
3. **Lock.** A lock directory on each server prevents two deploys at once.
4. **Distribute.** The image is pushed to a registry on your machine. Each server pulls through an SSH reverse tunnel and gets only the layers it does not have; the base image comes from Docker Hub on the server side. The running app is not touched.
5. **Activate.** Per server: save the current config, move `:latest` to `:previous`, write MUP's `start.sh` and `env.list`, restart the container, run the health check. A server that fails goes back to its previous image and config.
6. **Finish.** Write the deploy history on each server, remove old versions, release the locks.

Behind MUP's reverse proxy (the `proxy` section), step 5 replaces the container without a gap, or, with load balancing, takes each server out of the upstream while it restarts.

Details: [How it works](docs/how-it-works.md).

## Features

- **Drop-in for MUP 1.5.11.** The same `mup.js` / `mup.json`, the same `settings.json`, the same commands and options, the same `/opt/<name>` layout, container and image names, and `start.sh` from MUP's own template.
- **Build once, locally.** One build for all servers, with BuildKit and a layer cache for `npm install`.
- **Skip unchanged builds.** A content hash of the app decides whether a build is needed (`No changes since <version>`).
- **Delta transfer.** Only missing layers travel, through an SSH tunnel, to all servers in parallel.
- **Rollout strategies.** `canary` (default), `rolling` or `parallel`.
- **Strict health check.** HTTP status up to 499 counts as healthy (configurable); a crashed container fails at once.
- **Automatic revert.** A failed server returns to its previous image, `start.sh` and `env.list`, and the restored version is checked again.
- **Rollback in seconds.** `rollback` switches to an older version that is still on the server. The last 5 healthy versions are kept by default.
- **Deploy history.** Who deployed which version and commit, when, and with what result, per server.
- **Deploy lock.** Two people cannot deploy the same app at once. `unlock` releases a stale lock.
- **MUP's reverse proxy.** nginx-proxy with Let's Encrypt or your own certificate, and load balancing, run with MUP's own scripts and images. `deploy` and `reconfig` keep the app's proxy files up to date and never restart the proxy, which other apps on the server share.
- **No gap behind the proxy.** The new container starts beside the old one, which stops only when nginx routes to the new one. With load balancing, each server leaves the upstream while it restarts.
- **Mixed CPU architectures.** Detects `x86_64` and `aarch64` per server and builds once per platform.
- **Secrets stay secret.** Env values are masked in all output, never baked into the image, and `env.list` is written with mode `600`.
- **Clear errors.** Every error says what failed and, where possible, how to fix it.

## Benchmark

A local acceptance run, comet-deploy 0.1.0 against MUP 1.5.11:

| Scenario | Servers | comet-deploy | MUP 1.5.11 | Faster by |
|---|---|---|---|---|
| Code-only change: end of `meteor build` until all servers are healthy | 2 | 24.0 s | 67.7 s | 2.8x |
| | 4 | 22.6 s | 139.1 s | 6.2x |
| Code-only change: the whole deploy | 2 | 37.7 s | 87.3 s | 2.3x |
| | 4 | 35.9 s | 155.9 s | 4.3x |
| First deploy to empty servers | 2 | 99 s | 103 s | 1.0x |
| | 4 | 71 s | 196 s | 2.8x |

Where the time goes: MUP's "Prepare Bundle" step (`npm install` and `docker build` on the server) takes about 28 s per server and runs on one server after another. comet-deploy builds once and then needs about 2.5 s per server for the changed layers, in parallel.

Setup of the run:

- A sample Meteor 3.5.4 app with a native npm module (`bcrypt`).
- The "servers" were Docker containers with sshd and dockerd, on one Apple Silicon Mac, so the network was loopback.
- Config: top-level `meteor` section, `dockerImage: 'zodern/meteor:latest'`, `serverOnly`, `PORT` 8080, timezone mounts in `docker.args`, `deployCheckWaitTime: 120`, and `docker.useBuildKit: true` (MUP 1.5.11 fails to build this app with `EPERM` without it). Canary strategy. Fresh servers for each tool.

Caveats: the network was loopback, so upload time did not count. On a real network the gap is likely larger, because MUP uploads the whole bundle to every server. The app is small, and the local build cache was warm. Measure with your own app before you rely on these numbers.

To run it yourself (needs local Docker that can run privileged containers, and Meteor):

```bash
npm run build
BENCH_OUT=/tmp/comet-bench BENCH_SERVERS=2 npx vite-node test/bench/acceptance.ts
# BENCH_TOOLS=comet or BENCH_TOOLS=mup runs only one tool
```

## Requirements

### Your machine

| What | Version | Notes |
|---|---|---|
| Node.js | 20 or newer | |
| Meteor | the one your app uses | `meteor build` runs locally, as with MUP |
| Docker with BuildKit and buildx | a current Docker Desktop, OrbStack, or Docker Engine with the buildx plugin | **new compared to MUP**; `docker buildx inspect` must list your servers' platform |
| git | optional | the commit goes into the version name and the history |

macOS and Linux. Windows with WSL2 is not tested.

### Servers

The same as for MUP, plus SSH TCP forwarding:

| What | Notes |
|---|---|
| Linux on `x86_64` or `aarch64` | `setup` installs Docker with `apt-get` and `get.docker.com`, so Debian or Ubuntu for `setup`. With Docker installed, any distribution with bash works. |
| SSH with `pem`, `password` or an ssh agent | |
| `root`, or a user with passwordless sudo | every remote command runs through `sudo` |
| `bash`, `sudo`, `curl` | `curl` is used by the health check |
| Docker 18 or newer | `setup` installs it. MUP's proxy images were checked with Docker 27.5.1 and 29.9.3. |
| `AllowTcpForwarding yes` in `sshd_config` | the OpenSSH default; the image travels through an SSH reverse tunnel |

You also need a MongoDB that the servers can reach. MUP's built-in MongoDB (`mongo` section) is phase 2.

## Install

```bash
npm install -g comet-deploy
comet-deploy --version
comet-deploy --help
```

To run the code from `main` before it is released, install from source:

```bash
git clone https://github.com/mfeuermann/meteor-deploy.git
cd meteor-deploy
npm ci
npm run build
npm link
```

`npm link` makes the `comet-deploy` command available everywhere. It runs `dist/cli/main.js` from your clone, so after a `git pull` run `npm ci && npm run build` again.

## Quick start

### A new app

```bash
cd ~/code/myapp                # your Meteor app
comet-deploy init              # creates .deploy/mup.js and .deploy/settings.json
cd .deploy
# edit mup.js: servers, app name, ROOT_URL, MONGO_URL; delete the "mongo" section
comet-deploy validate
comet-deploy setup             # installs Docker on the servers
comet-deploy deploy
comet-deploy status
```

The full walkthrough: [Getting started](docs/getting-started.md).

### An app that MUP deploys today

```bash
cd ~/code/myapp/.deploy        # the folder where you run "mup deploy"
comet-deploy validate          # warnings about useBuildKit and similar are fine
comet-deploy deploy            # no "setup" needed on servers MUP set up
```

Check first that your config does not use a part that is still phase 2 (`mongo`, hooks, `privateDockerRegistry`, the default `kadirahq/meteord` image): [Migrating from MUP](docs/migrating-from-mup.md).

## Configuration

comet-deploy reads `./mup.js`, then `./mup.json`, or the file given with `--config`. The format is MUP's. A typical config:

```js
module.exports = {
  servers: {
    one: { host: '192.0.2.10', username: 'deployer', pem: '~/.ssh/id_ed25519' },
    two: { host: '192.0.2.11', username: 'deployer', pem: '~/.ssh/id_ed25519' },
  },

  app: {
    name: 'myapp',
    path: '../',
    servers: { one: {}, two: {} },      // the first one is the canary

    buildOptions: { serverOnly: true },

    env: {
      ROOT_URL: 'https://app.example.com',
      MONGO_URL: 'mongodb://myapp:secret@db.example.com:27017/myapp',
    },

    docker: {
      image: 'zodern/meteor:root',      // needed: the default kadirahq/meteord is phase 2
    },

    deployCheckWaitTime: 120,
  },

  // Optional: MUP's reverse proxy with Let's Encrypt.
  proxy: {
    domains: 'app.example.com',
    ssl: { letsEncryptEmail: 'admin@example.com', forceSSL: true },
  },

  // Optional, comet-deploy only. MUP reports it as an unknown property and continues.
  cometDeploy: {
    strategy: 'canary',
    keepVersions: 5,
    healthCheck: { path: '/', maxStatus: 499 },
  },
};
```

The `cometDeploy` section:

| Key | Default | Description |
|---|---|---|
| `strategy` | `'canary'` | `canary`: the first server, then the rest in parallel if it is healthy. `rolling`: one by one. `parallel`: all at once. `--strategy` overrides it. |
| `keepVersions` | `5` | Versions kept on each server for `rollback`. |
| `healthCheck.path` | `'/'` | Path the health check requests. |
| `healthCheck.maxStatus` | `499` | Highest HTTP status that counts as healthy. MUP accepts any answer; set `599` for that. |
| `platform` | `'auto'` | `auto` (detect per server), `'linux/amd64'` or `'linux/arm64'`. |
| `transfer` | `'auto'` | `auto` or `tunnel` (both use the SSH tunnel). `registry` and `stream` are phase 2. |
| `lock` | `true` | Deploy lock on the servers. |
| `zeroDowntime` | `true` | Behind the proxy: replace the container without a gap, and with load balancing take each server out of the upstream while it restarts. `false`: restart in place, as MUP does. |

Every option, the defaults, validation, paths, ignored and rejected MUP options: [Configuration](docs/configuration.md).

## Commands

| Command | What it does |
|---|---|
| `comet-deploy init` | Create `mup.js` and `settings.json` (the same files as `mup init`). |
| `comet-deploy validate` | Check the config. `--show` prints it with defaults, `--scrub` without secrets. |
| `comet-deploy setup` | Install Docker on the servers and create `/opt/<name>`. |
| `comet-deploy deploy` | Build once, send the missing layers, activate by strategy with health check and automatic revert. |
| `comet-deploy reconfig` | Write `env` and settings to the servers and restart, with the health check. No build. |
| `comet-deploy restart` | Restart the app by strategy, with the health check. |
| `comet-deploy start`, `stop` | Start or stop the app. |
| `comet-deploy logs` | `docker logs` from all servers; options pass through (`-f`, `--tail 50`). |
| `comet-deploy rollback` | Switch back to the previous kept version, or `--to <version>`. Seconds, no build. |
| `comet-deploy history` | Who deployed what, when, and the result. |
| `comet-deploy unlock` | Release a stale deploy lock. |
| `comet-deploy status` | Docker version, container state, version, HTTP status and lock per server. |
| `comet-deploy meteor …` | MUP's `meteor` subcommands (`deploy`, `push`, `build`, `setup`, `envconfig`, `destroy`, …); `comet-deploy meteor --help` lists them. |
| `comet-deploy docker …` | MUP's `docker` subcommands (`setup`, `update`, `restart`, `ps`, `status`). |
| `comet-deploy proxy …` | MUP's `proxy` subcommands (`setup`, `reconfig-shared`, `start`, `stop`, `logs`, `logs-le`, `nginx-config`, `status`). |

Global options, as in MUP: `--config`, `--settings`, `--servers` (space or comma separated), `--verbose`. Deploy options: `--strategy`, `--cached-build`, `--force-build`, `--force-unlock`.

Exit codes: `0` success, `1` error (including a server that was reverted), `130` aborted. On the first Ctrl+C, `deploy`, `reconfig`, `restart` and `rollback` finish the current step on the servers (a server that is being activated finishes its health check and revert), start no further server, release the locks and exit. A local `meteor build` or image build stops at once; nothing has changed on the servers at that point.

Every command and flag: [Commands](docs/commands.md).

## Differences from MUP

What stays the same: the config, the commands, the server layout, `start.sh` and `env.list`, the container options, MUP's own setup and start scripts. MUP and comet-deploy can manage the same app on the same servers (not at the same time).

What changes:

- Docker with buildx is needed on your machine; the image is built there.
- The server must allow SSH TCP forwarding.
- The app keeps running while the new image is built and sent.
- Servers get the image in parallel; activation follows a strategy instead of one server after another.
- The health check fails on 5xx answers and on a crashed container. MUP accepts any HTTP answer.
- `app.deployCheckPort` is used (MUP 1.5.11 ignores it).
- A failed server gets its previous config back too, and the restored version is checked.
- Validation errors stop the command (MUP prints them and continues).
- New: `rollback`, `history`, `unlock`, deploy lock, version tags on the servers.
- Behind the proxy: `deploy` and `reconfig` bring the app's proxy files up to date (MUP does it only in `setup`); the switch has no gap; with load balancing a server leaves the upstream while it restarts; the proxy containers restart only when their own files changed.
- Env values are not written into the image.

The full list and a side-by-side table: [Migrating from MUP](docs/migrating-from-mup.md).

## Limitations

comet-deploy does not include these MUP features yet. A config that uses them stops with a clear message, and MUP keeps working on the same config:

- the `mongo` section (MongoDB run by MUP). Use your own database;
- hooks (`hooks` in the config). A command with a hook on one of its steps stops before it does anything;
- `privateDockerRegistry`;
- MUP's bundle mode, used by the default `kadirahq/meteord` image. Set `docker.image: 'zodern/meteor:root'`;
- the commands `mongo`, `ssh`, `meteor debug`, and the full `status` report.

Not supported and not planned: Docker Swarm (`swarm`), MUP plugins (`plugins`).

Other limits of this release:

- Docker with buildx must run on the machine you deploy from. Building for another CPU architecture needs emulation, which is slow when the dependencies change.
- The servers must allow SSH reverse port forwarding. A transfer without it is phase 2.
- Server CPUs: `x86_64` and `aarch64`.
- `setup` installs Docker only on apt-based systems (Debian, Ubuntu), as MUP does.
- `rollback` changes only the image; the current `start.sh` and `env.list` stay.
- Locks do not expire, and MUP does not know them.
- The local registry volume (`comet-deploy-registry-data`) is never cleaned up and grows with every deploy; remove it by hand when needed. Local images are limited to the last 20 builds per app. See [Troubleshooting](docs/troubleshooting.md#leftover-local-images-and-the-registry-volume).
- SSH host keys are not verified, the same as with MUP.
- The proxy's Let's Encrypt part is tested against a local ACME test server (Pebble), not against Let's Encrypt itself.

## Roadmap

**Phase 1: done.** `init`, `validate`, `setup`, `deploy`, `reconfig`, `restart`, `start`, `stop`, `logs`, `rollback`, `history`, `unlock`, `status`, `meteor destroy`, the `docker` subcommands and the `meteor` variants of the commands. Local build with a cached dependency layer, delta transfer through an SSH tunnel, rollout strategies, health check with automatic revert, deploy lock and history, per-server CPU architecture.

**Phase 2: in progress.**

- Done: the reverse proxy (nginx-proxy, Let's Encrypt, load balancing; the `proxy` section and commands) and zero-downtime deploys behind it (`cometDeploy.zeroDowntime`).
- MongoDB run on the servers (the `mongo` section and commands).
- Hooks and MUP's plugin API for hooks.
- Image transfer through a private registry (`privateDockerRegistry`, `transfer: 'registry'`) and over plain SSH without forwarding (`transfer: 'stream'`).
- MUP's bundle mode (`kadirahq/meteord`).
- `meteor debug`, `ssh`, the full `status` report, and a command to prune the local build cache.

**Phase 3: in progress.**

- Done: the npm package, CI on GitHub Actions, releases from a version tag.
- Documentation and examples for deploying from CI.

**Not planned.** Docker Swarm. Third-party MUP plugins.

## FAQ

**Do I have to change my `mup.js`?**
Usually not. Set `docker.image` to a `zodern/meteor` image if you use the default, and check the [phase 2 list](docs/migrating-from-mup.md#check-first-what-does-not-work-yet).

**Can I go back to MUP?**
Yes. Run `mup deploy` again. The servers have the same layout; MUP ignores the files comet-deploy adds. See [Going back to MUP](docs/migrating-from-mup.md#going-back-to-mup).

**Can MUP and comet-deploy work on the same servers?**
Yes, but not at the same time: MUP does not know comet-deploy's lock.

**Can an app deployed with MUP and one deployed with comet-deploy share the proxy on a server?**
Yes. The proxy, its files and its containers are MUP's. comet-deploy changes only the files of the app it deploys, and restarts the proxy only in `proxy setup`, `proxy start` and `proxy reconfig-shared`.

**Why does it need Docker on my machine?**
Because the image is built there, once. That is what makes the deploy fast: no `npm install` on the servers, and only the changed layers travel.

**Why does it need `AllowTcpForwarding`?**
Each server pulls the image from a registry on your machine through an SSH reverse tunnel. Nothing else is opened: the registry listens on `127.0.0.1` on your machine, and the tunnel on `127.0.0.1` on the server, only during the deploy.

**I build on an Apple Silicon Mac and my servers are `x86_64`. Does that work?**
Yes, with amd64 emulation (Rosetta in Docker Desktop, on by default in OrbStack). It is slower only when the dependency layer is rebuilt. See [Troubleshooting](docs/troubleshooting.md#building-on-an-arm64-mac-for-amd64-servers).

**What happens if the new version does not start?**
The health check fails, the server returns to its previous image and config, and the restored version is checked. With the `canary` strategy, when the first server fails, the other servers are not touched. See [How it works](docs/how-it-works.md#automatic-revert).

**How do I go back to an older version?**
`comet-deploy rollback` (one version back) or `comet-deploy rollback --to <version>`. `comet-deploy history` lists the versions.

**I changed only an env variable or a setting. Do I need a full deploy?**
No. `comet-deploy reconfig` writes the new `env.list`, restarts and checks the app, without a build.

**How do I deploy to one server only?**
`comet-deploy deploy --servers one` (or `--servers one,two`).

**What does a version name look like?**
`20261111-091502-3f2a1c9`: the UTC start time and the short git commit, with `-dirty` for uncommitted changes.

**Are my secrets safe in the output and in the image?**
Env values (except public ones such as `ROOT_URL` and `PORT`), passwords, the key passphrase and the settings are replaced by `***` in all output. Env values do not go into the image (except keys that your `buildInstructions` reference, with a warning). `env.list` on the server has mode `600`.

**Does it work in CI?**
It does not prompt, and without a terminal the output is plain text. A CI setup is not documented or tested yet (phase 3).

**Why is the first deploy not much faster than MUP?**
The first build runs the full `npm install`, and a new server gets the whole image once. The gain comes with the following deploys.

## Documentation

- [Getting started](docs/getting-started.md): from nothing to a running app.
- [Configuration](docs/configuration.md): every option.
- [Commands](docs/commands.md): every command and flag.
- [How it works](docs/how-it-works.md): build, distribution, activation, health check, revert, locks, history.
- [Migrating from MUP](docs/migrating-from-mup.md): what stays, what changes, how to go back.
- [Troubleshooting](docs/troubleshooting.md): common errors and fixes.

## Development

```bash
npm ci
npm run build              # bundle with tsup into dist/
npm test                   # unit tests (vitest)
npm run lint               # eslint
npm run typecheck          # tsc --noEmit
npm run test:integration   # integration and end-to-end tests (heavy, see below)
npm run test:package       # pack the npm package, install it and run it (needs the npm registry)
```

Releases: [docs/releasing.md](docs/releasing.md).

Source layout:

| Path | What is in it |
|---|---|
| `src/cli/` | Command line and commands (yargs) |
| `src/config/` | Loading, MUP-compatible normalization and validation of `mup.js` |
| `src/core/` | Command context, the hook-aware step runner, errors |
| `src/build/` | `meteor build`, the generated Dockerfile, the input hash and build cache |
| `src/local/` | Running local processes and the local `docker` CLI |
| `src/transfer/` | Local registry and SSH reverse tunnel |
| `src/deploy/` | Preflight, the deploy pipeline, activation, zero-downtime switch, health check, rollback, history |
| `src/proxy/` | MUP's reverse proxy: setup, file sync, the load balancing upstream and draining |
| `src/remote/` | Rendering and running the remote scripts |
| `src/ssh/` | SSH connections (ssh2) |
| `src/output/` | Output, tables, secret masking |
| `templates/mup/` | Files copied unchanged from MUP 1.5.11 (scripts, `start.sh` and `env.list` templates, the proxy scripts and `nginx.tmpl`, the `init` sample) |
| `templates/comet/` | comet-deploy's own remote scripts (lock, history, snapshot, retag, health check, pull, proxy state and reload) |
| `test/` | Unit tests, integration and e2e tests, the test-server harness, the benchmark |

**Integration tests** (`npm run test:integration`) are slow and use a lot of resources. They need:

- local Docker that can run **privileged** containers. The tests start disposable "servers": Debian containers with sshd, their own Docker daemon and a passwordless-sudo user;
- Meteor on your machine (the end-to-end tests build the sample app in `test/fixtures/sample-app`);
- the MUP 1.5.11 dev dependency, which the tests run to compare comet-deploy's output with MUP's and to check that both tools work on the same servers.

The test files run one after another, with timeouts of up to 10 minutes per test.

## Contributing

Issues and pull requests are welcome at [github.com/mfeuermann/meteor-deploy](https://github.com/mfeuermann/meteor-deploy).

- **Keep the server state compatible with MUP 1.5.11.** A server deployed by comet-deploy must keep working with `mup restart`, `mup logs` and `mup deploy`, and the other way round. The interop tests check this.
- **Do not edit the files in `templates/mup/`.** They are unchanged copies of MUP 1.5.11 (see `NOTICE`). comet-deploy's own scripts belong in `templates/comet/`.
- New options go into the `cometDeploy` section, never into MUP's sections.
- Run `npm run lint`, `npm run typecheck` and `npm test` before you open a pull request. Run the integration tests for changes to anything that runs on the servers.
- For a bug report, `comet-deploy validate --scrub` prints your config without hosts, passwords and URLs.

## License and credits

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Marek Feuermann.

comet-deploy is built on the work of [Meteor Up](https://github.com/zodern/meteor-up). It includes files from Meteor Up 1.5.11 (the remote scripts, the `start.sh` and `env.list` templates, the proxy scripts and `nginx.tmpl`, and the `init` sample), used under the MIT License, Copyright (c) 2016 Kadira Inc. The list of these files is in [NOTICE](NOTICE).
