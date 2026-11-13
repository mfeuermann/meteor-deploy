# Troubleshooting

[README](../README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Commands](commands.md) · [How it works](how-it-works.md) · [Migrating from MUP](migrating-from-mup.md) · **Troubleshooting**

Most errors say what is wrong and print a `Hint:` with the fix. This page lists the common ones by the step where they appear. For more detail, run the command again with `--verbose`: it prints the output of `meteor build`, `docker buildx build` and the remote scripts.

`deploy` checks your machine and all servers first (preflight) and lists every problem at once under `Preflight failed:`, before it builds anything.

**Your machine**

- [Local Docker is not available](#local-docker-is-not-available)
- [The local Docker builder cannot build for linux/amd64](#the-local-docker-builder-cannot-build-for-linuxamd64)
- [Docker buildx is not available](#docker-buildx-is-not-available)
- [Building on an arm64 Mac for amd64 servers](#building-on-an-arm64-mac-for-amd64-servers)
- [The meteor command was not found](#the-meteor-command-was-not-found)

**SSH and the servers**

- [Cannot connect to server](#cannot-connect-to-server)
- [sudo asks for a password](#sudo-asks-for-a-password)
- [AllowTcpForwarding is disabled on the server](#allowtcpforwarding-is-disabled-on-the-server)
- [Docker is not installed or too old on the server](#docker-is-not-installed-or-too-old-on-the-server)
- [The config directory does not exist](#the-config-directory-does-not-exist)
- [Low disk space on a server](#low-disk-space-on-a-server)
- [The SSH connection closed](#the-ssh-connection-closed)

**Config**

- [Config or settings not found](#config-or-settings-not-found)
- [validate exits with code 1](#validate-exits-with-code-1)
- [The docker image cannot build an app image](#the-docker-image-cannot-build-an-app-image)
- [Not supported yet (phase 2)](#not-supported-yet-phase-2)
- [imagePrefix does not point to the registry](#imageprefix-does-not-point-to-the-registry)
- [app.ssl is a deprecated MUP option](#appssl-is-a-deprecated-mup-option)
- [env.list line over 64 KiB](#envlist-line-over-64-kib)

**Build**

- [Not a Meteor app](#not-a-meteor-app)
- [meteor build failed](#meteor-build-failed)
- [docker buildx build failed](#docker-buildx-build-failed)
- [It builds every time](#it-builds-every-time)
- [npm install runs again](#npm-install-runs-again)
- [--cached-build: no cached image found](#--cached-build-no-cached-image-found)
- [Cache export is not supported for the docker driver](#cache-export-is-not-supported-for-the-docker-driver)
- [Docker Hub rate limits](#docker-hub-rate-limits)

**Deploy and after**

- [A deploy lock is held](#a-deploy-lock-is-held)
- [Image distribution failed](#image-distribution-failed)
- [Saving the image for the transfer over SSH failed](#saving-the-image-for-the-transfer-over-ssh-failed)
- [Timed out waiting for the registry lock](#timed-out-waiting-for-the-registry-lock)
- [Logging in to the private registry failed](#logging-in-to-the-private-registry-failed)
- [Pushing to the private registry failed](#pushing-to-the-private-registry-failed)
- [A server cannot pull from the private registry](#a-server-cannot-pull-from-the-private-registry)
- [The private registry's certificate is not trusted](#the-private-registrys-certificate-is-not-trusted)
- [:latest in the private registry was not updated](#latest-in-the-private-registry-was-not-updated)
- [Rollback refused after a MUP deploy with a registry](#rollback-refused-after-a-mup-deploy-with-a-registry)
- [Health check failed and the server was reverted](#health-check-failed-and-the-server-was-reverted)
- [The restored version is not healthy either](#the-restored-version-is-not-healthy-either)
- [Mixed versions after a partial failure](#mixed-versions-after-a-partial-failure)
- [Nothing to roll back to](#nothing-to-roll-back-to)
- [Leftover local images and the registry volume](#leftover-local-images-and-the-registry-volume)

**Hooks**

- [A hook failed](#a-hook-failed)
- [A remote command failed but the deploy went on](#a-remote-command-failed-but-the-deploy-went-on)
- [A hook never runs](#a-hook-never-runs)
- [api.runCommand cannot run while comet-deploy holds the deploy lock](#apiruncommand-cannot-run-while-comet-deploy-holds-the-deploy-lock)
- [api.getSessions() is not supported](#apigetsessions-is-not-supported)

**MongoDB**

- [MongoDB is not running](#mongodb-is-not-running)
- [A MongoDB version change is refused](#a-mongodb-version-change-is-refused)
- [Before the next MongoDB upgrade](#before-the-next-mongodb-upgrade)
- [MongoDB version change not checked](#mongodb-version-change-not-checked)

**The reverse proxy**

- [The reverse proxy is not set up](#the-reverse-proxy-is-not-set-up)
- [A server stays out of load balancing](#a-server-stays-out-of-load-balancing)
- [Zero-downtime switch not used](#zero-downtime-switch-not-used)
- [The shared proxy settings differ](#the-shared-proxy-settings-differ)
- [Load balancing was not enabled](#load-balancing-was-not-enabled)
- [Updating the reverse proxy failed](#updating-the-reverse-proxy-failed)
- [A load-balanced server is down for longer](#a-load-balanced-server-is-down-for-longer)
- [No Let's Encrypt certificate](#no-lets-encrypt-certificate)

---

## Your machine

### Local Docker is not available

```
Local Docker is not available: docker is not installed (command not found)
```

comet-deploy builds the image on your machine, so it needs a running Docker with BuildKit and buildx. Install Docker Desktop, OrbStack, or Docker Engine with the buildx plugin on Linux.

If Docker is installed but not running, the message contains Docker's own error, for example `Cannot connect to the Docker daemon … Is the docker daemon running?`. Start Docker and check:

```bash
docker version
docker buildx version
```

### The local Docker builder cannot build for linux/amd64

```
The local Docker builder cannot build for linux/amd64. Enable emulation: Docker Desktop → Settings → General →
"Use Rosetta for x86_64/amd64 emulation", or run "docker run --privileged --rm tonistiigi/binfmt --install all".
```

The servers run a platform that your buildx builder does not list. See the platforms:

```bash
docker buildx inspect | grep Platforms
```

- On an Apple Silicon Mac, see the next section.
- On an arm64 Linux machine, install QEMU emulation: `docker run --privileged --rm tonistiigi/binfmt --install all`.
- If you switched to another builder (`docker buildx use …`), it must support the platform too.

### Docker buildx is not available

```
Docker buildx is not available locally ("docker buildx inspect" failed). Install the buildx plugin; Docker Desktop and OrbStack include it.
```

Docker runs, but the buildx builder lists no platforms. Usually the buildx plugin is missing (common with Docker Engine on Linux, where it is a separate package such as `docker-buildx-plugin`). Check with `docker buildx version` and `docker buildx inspect --bootstrap`. comet-deploy starts a builder that is not running yet; if the current builder (`docker buildx ls`, marked `*`) cannot start, switch to a working one with `docker buildx use <name>`.

### Building on an arm64 Mac for amd64 servers

Most servers are `x86_64`. An Apple Silicon Mac builds their image under emulation.

- **Docker Desktop:** Settings → General → "Use Rosetta for x86_64/amd64 emulation on Apple Silicon". Restart Docker Desktop.
- **OrbStack:** amd64 emulation is on by default.
- **Other setups:** `docker run --privileged --rm tonistiigi/binfmt --install all`.

Emulation is slower. It matters only when the dependency layer is rebuilt (`npm install` and native modules), that is on the first build and when the dependencies change. Code-only changes reuse the cached layer.

If you see `exec format error` in the build output, emulation is not active for that platform.

For `aarch64` servers (for example ARM cloud instances) the build on an Apple Silicon Mac is native. comet-deploy detects each server's architecture with `uname -m`; to force one platform for all servers, set `cometDeploy.platform`.

### The meteor command was not found

```
The "meteor" command was not found locally. Install Meteor to build the app.
```

`meteor build` runs on your machine, as with MUP. Install Meteor, or set `app.buildOptions.executable` to the command you use (preflight runs `<executable> --version`).

---

## SSH and the servers

### Cannot connect to server

```
Cannot connect to server "one" (192.0.2.10:22): All configured authentication methods failed
Hint: Check host, port, username and the SSH key/password in the config.
```

Check, in this order:

1. `ssh -i <pem> <username>@<host> -p <port>` works from the same machine.
2. `servers.<name>.pem` is the **private** key. A `.pub` file is a validation error: `servers.one.pem Needs to be a path to a private key. The file extension ".pub" is used for public keys.`
3. The `pem` path. It is relative to the current directory, then to the config folder. `~` works.
4. The port: `servers.<name>.opts.port` (default 22).
5. A key with a passphrase: set `servers.<name>.opts.passphrase`, or load the key into your ssh agent and leave out `pem`. Every key in `opts` goes to the SSH client without a validation warning.
6. A slow server or network: raise `servers.<name>.opts.readyTimeout` (milliseconds, default 60000).

comet-deploy does not read `~/.ssh/config` (neither does MUP). Put the real host name, user, port and key path into `mup.js`.

Without `pem` and `password`, comet-deploy uses the ssh agent (`SSH_AUTH_SOCK`). If there is none:

```
No SSH authentication for server "one" (192.0.2.10).
Hint: Set "pem" or "password" for the server, or start an ssh agent (SSH_AUTH_SOCK).
```

Host keys are not verified, the same as with MUP.

### sudo asks for a password

```
Server "one": sudo asks for a password. The SSH user needs passwordless sudo, like with MUP
(e.g. "deployer ALL=(ALL) NOPASSWD:ALL" in /etc/sudoers.d/deployer), or connect as root.
```

Every remote command runs through `sudo`, as with MUP. On the server, as root:

```bash
echo 'deployer ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/deployer
chmod 0440 /etc/sudoers.d/deployer
visudo -cf /etc/sudoers.d/deployer
```

Replace `deployer` with your SSH user. Or use `username: 'root'`.

If sudo is missing:

```
Server "one": sudo is not installed. Every remote command runs through sudo (as with MUP); install it, e.g. "apt-get install sudo".
```

### AllowTcpForwarding is disabled on the server

With the default `cometDeploy.transfer: 'auto'` this is a warning, and the deploy goes on:

```
Warning: Server "one": SSH port forwarding is off (<reason from the server>), so comet-deploy sends the whole image over SSH,
which is slower. To send only the changed layers, set "AllowTcpForwarding yes" in /etc/ssh/sshd_config and reload sshd.
```

With `cometDeploy.transfer: 'tunnel'` it is a preflight error:

```
Server "one": SSH reverse port forwarding does not work (<reason from the server>). comet-deploy sends the image through it:
set "AllowTcpForwarding yes" in /etc/ssh/sshd_config and reload sshd. Or set cometDeploy.transfer to "auto" to send the whole
image over SSH instead.
```

comet-deploy sends the image layers through an SSH reverse tunnel: the server pulls from `127.0.0.1:<port>`, which leads back to a registry on your machine, so only the layers the server does not have travel. Preflight opens and closes such a tunnel on every server before the build. A server that refuses it gets the whole image as a compressed `docker save` archive over SSH instead (`[one] distribute ✓ 41.2s (whole image, 312 MB)`), on every deploy of a new version. That works, but takes longer. To use the tunnel, allow forwarding on the server:

See the effective settings on the server:

```bash
sudo sshd -T | grep -iE '^(allowtcpforwarding|disableforwarding|permitlisten)'
```

Fix it in `/etc/ssh/sshd_config` (or a file in `/etc/ssh/sshd_config.d/`):

| Setting | Needed value |
|---|---|
| `AllowTcpForwarding` | `yes` (the default) or `remote` |
| `DisableForwarding` | `no` (the default). `yes` turns off all forwarding. |
| `PermitListen` | not set, or one that allows `127.0.0.1` on any port, for example `PermitListen 127.0.0.1:*` |

Also check `Match` blocks for your SSH user or group: they can override these settings. Then reload the SSH server:

```bash
sudo systemctl reload ssh     # Debian, Ubuntu
sudo systemctl reload sshd    # most other distributions
```

If you cannot change `sshd_config` (shared hosting, a server another team manages), keep `transfer: 'auto'`, or set `transfer: 'stream'` to send the whole image to every server without checking forwarding.

### Docker is not installed or too old on the server

```
Server "one": Docker is not installed. Run "comet-deploy setup".
Server "one": Docker is not running. Run "comet-deploy setup".
Server "one": Docker 17.12.1 is too old (minimum 18). Run "comet-deploy docker update".
```

`setup` installs Docker with `get.docker.com` (apt-based systems: Debian, Ubuntu), or starts it if it is installed. On other distributions, install Docker yourself and start it.

`comet-deploy docker status` shows the Docker version on every server and exits with code 1 (`Docker is not usable on: <servers>`) when Docker is missing, stopped or too old somewhere, so you can use it in scripts.

The health check uses `curl` on the server. `setup` installs it only together with Docker. If Docker was already there and `curl` is missing, install it (`sudo apt-get install curl`).

### The config directory does not exist

`deploy` and `meteor push` report it in preflight, before the build:

```
Preflight failed:
  - Server "one": the app is not set up on this server yet. Run "comet-deploy setup" first.
```

`reconfig`, `restart` and `rollback` have no preflight; they fail when they take the lock, because the lock lives in that directory:

```
Cannot lock the servers:
  - Server "one": [one] Cannot write to /opt/myapp/config: …
Hint: Run "comet-deploy setup" first.
```

The server was never set up for this app (or `app.name` changed). Run `comet-deploy setup` (or `comet-deploy meteor setup` for the directories only). `setup` makes the SSH user the owner of `/opt/<name>`; if you later connect as another user, run it again.

### Low disk space on a server

```
Warning: Server "one": only 3.2 GiB free for Docker.
```

A warning below 5 GiB free in Docker's data directory. The deploy continues, but a pull can fail when the disk is full. See what uses the space:

```bash
sudo docker system df
sudo docker images
```

comet-deploy keeps `cometDeploy.keepVersions` versions (default 5) for rollback and runs `docker image prune -f` after each deploy. To free more, lower `keepVersions`, or remove images of other apps. `docker image prune -a` also removes the kept versions and `:previous`, so rollback has nothing to go back to.

### The SSH connection closed

```
[one] The SSH connection to 192.0.2.10 closed: a command was interrupted
Hint: Check the network and the server, then run the command again.
```

The server or the network went away during a command. comet-deploy opens a new connection for the steps that follow, so the lock release at the end usually still works. If it does not, you see:

```
Warning: Could not release the deploy lock on "one": … Run "comet-deploy unlock --servers one".
```

Check what state the server is in with `comet-deploy status`, then deploy again.

---

## Config

### Config or settings not found

```
"mup.js" or "mup.json" not found in /home/jane/code/myapp.
Hint: Run "comet-deploy init" to create one, or pass --config <path>.
```

Run the command in the folder with `mup.js` (often `.deploy/` in the app), or pass `--config`.

```
Settings file not found: /home/jane/code/myapp/.deploy/settings.json
Hint: Create it or pass --settings <path>.
```

The default settings file is `settings.json` next to the config. For an app without settings, create a file with `{}`.

### validate exits with code 1

`validate` exits with 1 on any problem, warnings included (as `mup validate` does). The other commands stop only on errors. Typical warnings on a MUP config that you can keep:

```
Warning: app.docker.useBuildKit ignored: comet-deploy always builds locally with BuildKit
```

Which problems are errors: [Configuration → Validation](configuration.md#validation).

### The docker image cannot build an app image

```
The docker image "kadirahq/meteord" cannot build an app image (MUP bundle mode). Bundle mode is planned for phase 2 of comet-deploy.
Hint: Use a zodern/meteor image (app.docker.image), e.g. "zodern/meteor:root".
```

Without `app.docker.image`, MUP's default `kadirahq/meteord` is used, which only supports MUP's bundle mode. Set:

```js
docker: {
  image: 'zodern/meteor:root',
},
```

`validate` does not catch this; the build does.

### Not supported yet (phase 2)

```
"ssh one" is not supported yet: it is planned for phase 2 of comet-deploy.
```

The `ssh` and `meteor debug` commands, and MUP's bundle mode, are phase 2. Use MUP for them meanwhile; it works on the same config and servers. See [Configuration → Planned for phase 2](configuration.md#planned-for-phase-2) and [Migrating from MUP](migrating-from-mup.md#check-first-what-does-not-work-yet).

### imagePrefix does not point to the registry

```
privateDockerRegistry.imagePrefix is required: it is where comet-deploy pushes the image, for example "registry.example.com/myteam".
privateDockerRegistry.imagePrefix "team" would push to docker.io, not to the registry "registry.example.com" in privateDockerRegistry.host. Start it with the registry host, for example "registry.example.com/team".
```

Docker sends an image to the registry in the first part of its name (a part with a `.` or a `:`, or `localhost`), and to Docker Hub otherwise. The image holds your app's bundle, so comet-deploy stops before preflight rather than push it somewhere else than `host`. Start `imagePrefix` with the registry from `host`. MUP uses the same prefix, so the config keeps working there. See [Configuration → privateDockerRegistry](configuration.md#privatedockerregistry).

### app.ssl is a deprecated MUP option

```
app.ssl is a deprecated MUP option that comet-deploy does not support. MUP replaced it with the "proxy" section: move the domain and certificate settings there, or keep deploying this app with MUP.
```

MUP 1.4 replaced `app.ssl`, `app.nginx` and `docker.imageFrontendServer` with the `proxy` section. Move the domains to `proxy.domains` and the certificate to `proxy.ssl` (`crt` and `key`, or `letsEncryptEmail`); see [Configuration → `proxy`](configuration.md#proxy). MUP 1.5.11 works with the new section too.

### env.list line over 64 KiB

```
The env.list for server "one" has a METEOR_SETTINGS line of 81 KiB. Docker reads --env-file lines only up to 64 KiB, so the app could not start.
```

Docker cannot read longer lines from an env file, so the app would not start (MUP fails the same way, later). The check runs before the build, and nothing changes on the servers. Make the settings smaller: move large data out of `settings.json`, for example into a file or the database.

---

## Build

### Not a Meteor app

```
/home/jane/code/myapp/.deploy is not a Meteor app (.meteor/release not found).
Hint: Check app.path in the config.
```

`app.path` is relative to the folder of the config (or of `--config`). For a config in `<app>/.deploy/`, it is `'../'`.

### meteor build failed

```
meteor build failed (exit code 1). Last output:
…
Hint: Run with --verbose to see the full build output.
```

The last lines of Meteor's output are in the message. Run the same build yourself in the app to see the whole error:

```bash
meteor build --directory /tmp/build-test --server-only
```

Exit code 127 means the command was not found (`buildOptions.executable`).

### docker buildx build failed

```
docker buildx build failed for linux/amd64 (exit code 1):
<the last 60 lines of the build log>
```

Common causes:

- **`npm install` fails inside the image.** A native module may need system packages that the base image lacks. Add them with `app.docker.buildInstructions`, for example `['RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++']`.
- **`exec format error`.** Emulation for the target platform is not active. See [Building on an arm64 Mac for amd64 servers](#building-on-an-arm64-mac-for-amd64-servers).
- **The base image cannot be pulled.** Check `docker.image` and see [Docker Hub rate limits](#docker-hub-rate-limits).

Run with `--verbose` to see the whole build log.

### It builds every time

comet-deploy skips the build only when nothing that can change the image has changed. It hashes every file under `app.path` by content, except `.meteor/local`, `node_modules`, `.git`, the build directory, and the folder with `mup.js` when it is a dot folder inside the app (for example `.deploy/`).

Editing `mup.js` or `settings.json` in `.deploy/` therefore does not trigger a build. A config folder without the dot (`deploy/`) or a `mup.js` in the app root does count, because Meteor loads those files: move the config to `.deploy/` to stop the rebuilds. Changing the value of an `env` key that `docker.buildInstructions` use also triggers a build. If you only changed other `env` values or settings, run `comet-deploy reconfig` instead of `deploy`: it does not build.

Other files that often change between deploys: logs or uploads written into the app folder, generated files, editor temp files. Keep them out of the app folder, or accept the build: with the cached dependency layer it is usually short.

### npm install runs again

The `npm install` layer is reused when the files it reads are byte-identical. It runs again when:

- the app's npm dependencies changed (`package.json`, `package-lock.json`), or Meteor was updated (it changes `programs/server/package.json` and the shrinkwrap in the bundle);
- `docker.image` or `docker.buildInstructions` changed (they come before the layer);
- it is the first build for a platform on this machine, or on this builder (`docker buildx ls`);
- the local build cache was cleared (`docker builder prune`, or Docker's automatic cache cleanup);
- the build runs on a fresh CI runner without `--cache-from`. See [Deploying from CI](ci.md#the-build-cache-between-runs).

Run with `--verbose` and look for `CACHED` on the `npm install` step.

### Cache export is not supported for the docker driver

```
docker buildx build failed for linux/amd64 (exit code 1):
...
ERROR: Cache export is not supported for the docker driver.
```

`--cache-to` needs a buildx builder that can export a build cache. The default `docker` driver can do that only with Docker's containerd image store. Create a builder with the `docker-container` driver and make it the current one:

```bash
docker buildx create --use --name comet
```

In GitHub Actions, `docker/setup-buildx-action` does this. See [Deploying from CI](ci.md#the-build-cache-between-runs).

### --cached-build: no cached image found

```
Unable to use previous build for linux/amd64: no cached image found.
Hint: Deploy without --cached-build.
```

`--cached-build` reuses the newest local build for each platform. There is none on this machine for that platform (or its image was removed). Deploy without the flag once.

### Docker Hub rate limits

The base image (`docker.image`) comes from Docker Hub, which limits anonymous pulls.

- **Locally**, comet-deploy runs `docker pull` for the base image before the build and ignores a failure. If the build itself then fails with `toomanyrequests`, run `docker login`. The local registry container uses the `registry:2.8.3` image, which is also pulled from Docker Hub on the first deploy.
- **On the server**, each server pulls the base image from Docker Hub itself. If that fails, the pull through the tunnel brings the base layers from your machine instead: slower, but the deploy works. To pull from Docker Hub with an account, log in on the server with `sudo docker login` (comet-deploy runs `docker` through `sudo`).

---

## Deploy and after

### A deploy lock is held

```
Server "one": a deploy lock is held by jane@laptop (pid 4242, "deploy", since 2026-11-11T09:15:02.118Z).
If no deploy is running, release it with "comet-deploy unlock".
```

Preflight reports a lock that is already there. If another run takes the lock while your build runs, the Lock step stops instead:

```
Cannot lock the servers:
  - Server "one" is locked by jane@laptop ("deploy" since 2026-11-11T09:15:02.118Z)
Hint: Wait for the other deploy to finish. If none is running, release the lock with "comet-deploy unlock" (or add --force-unlock).
```

`deploy`, `reconfig`, `restart` and `rollback` take a lock on every server, so two runs cannot change the same app at once. If someone else is deploying, wait. If nobody is (the process was killed, the network dropped, or Ctrl+C was pressed twice), release it:

```bash
comet-deploy unlock                 # all app servers
comet-deploy unlock --servers one   # one server
comet-deploy deploy --force-unlock  # release and deploy
```

Locks do not expire. `unlock` prints who held the lock.

### Image distribution failed

```
Image distribution failed:
  - two: …
Hint: No server was changed.
```

A server could not pull or load the image. All servers keep their old version, because activation starts only after every server has the image. Common causes: a full disk on the server, a network problem, Docker not running. Fix it and deploy again; the build is skipped if nothing changed.

For a server that gets the whole image over SSH, the line says `Loading the image failed`, with the output of `sudo docker load` on that server.

### Saving the image for the transfer over SSH failed

```
Saving mup-myapp:20261107-183005 for the transfer over SSH failed: <error>
Hint: The archive is written to /tmp: check the free disk space there and that the local Docker runs.
```

For servers without SSH forwarding, comet-deploy saves the image with `docker save` into a compressed file in your temporary directory (`os.tmpdir()`, mode 600) before anything goes to the servers, so no server was changed. The file is about the size of the image's layers after gzip. Free disk space there, or point `TMPDIR` to a disk with more room, and deploy again. The file is removed after the deploy, also after an error or Ctrl+C.

### Timed out waiting for the registry lock

```
Timed out waiting for /home/jane/.cache/comet-deploy/registry-leases.lock (held by process 4242)
Hint: Another comet-deploy is starting or stopping the local registry. If none is running, delete the file.
```

All deploys on your machine share one local registry. A short lock file makes starting and stopping it safe when several deploys run at once. A lock left by a process that no longer runs is taken over automatically; this error comes only after 120 seconds of waiting for a live process. If no other comet-deploy is running, delete the file and deploy again.

### Logging in to the private registry failed

```
Logging in to the registry "registry.example.com" failed: Error response from daemon: Get "https://registry.example.com/v2/": unauthorized
Hint: Check privateDockerRegistry.username and password. Nothing was built or pushed, and no server was changed.
```

comet-deploy runs `docker login --username <username> --password-stdin <host>` on your machine after preflight. The password is never printed. Check the credentials with `docker login registry.example.com` by hand. A login that fails with `x509` or `server gave HTTP response to HTTPS client` is about trust; see [The private registry's certificate is not trusted](#the-private-registrys-certificate-is-not-trusted).

### Pushing to the private registry failed

```
Pushing registry.example.com/team/mup-myapp:20261107-183005 to the registry failed: denied: requested access to the resource is denied
Hint: Check that the registry account may push to "registry.example.com/team". No server was changed.
```

The push runs before anything reaches the servers. `denied` or `unauthorized`: the account may not push to that path (check `imagePrefix` and the account's rights); without `username` and `password` in the config, log in first with `docker login <host>`. Any other error (`connection refused`, `no such host`, a timeout): your machine cannot reach the registry. The local tag made for the push is removed in both cases.

### A server cannot pull from the private registry

```
Image distribution failed:
  - two: [two] Pulling registry.example.com/team/mup-myapp:20261107-183005 failed (exit code 1):
    Error response from daemon: … no basic auth credentials
    The server is not logged in to the registry: run "comet-deploy docker setup", which runs docker login on the servers.
Hint: No server was changed.
```

Each server pulls with its own Docker, which needs its own login. `comet-deploy docker setup` (and `setup`) run MUP's `docker login` on the servers when the config has `username` and `password`; without them, run `sudo docker login <host>` on the server. Other pull errors are the server's network or DNS, or the registry's certificate (below). No server was changed, because activation starts only after every server has the image.

### The private registry's certificate is not trusted

```
x509: certificate signed by unknown authority
http: server gave HTTP response to HTTPS client
```

Docker talks HTTPS to a registry and checks its certificate, on your machine and on every server. comet-deploy changes neither. Either give the registry a certificate the machines trust (for a private CA: `/etc/docker/certs.d/<host>/ca.crt` on each server, and your system's or Docker Desktop's trust store locally), or, for a registry without TLS in a trusted network, add it to `insecure-registries` in `/etc/docker/daemon.json` (Docker Desktop: Settings → Docker Engine) and restart Docker. Docker allows `127.0.0.0/8` without TLS on its own.

### :latest in the private registry was not updated

```
registry: registry.example.com/team/mup-myapp:latest not updated (the deploy did not include every app server).
Pushing registry.example.com/team/mup-myapp:latest to the registry failed: … The deploy itself succeeded; only MUP reads this tag ("mup reconfig" would run the previous version).
```

comet-deploy never reads `:latest` in the registry; it is there for MUP, whose `start.sh` pulls it. It is moved only after a deploy that ended healthy on every app server with one CPU architecture. The first line is information: a `--servers` deploy, a failed server or a mixed-architecture deploy leaves it on the version before. The second is a warning: the deploy succeeded, but MUP would start the older version. Fix the push (see above) and deploy again, or ignore it if you do not run MUP on this app.

### Rollback refused after a MUP deploy with a registry

```
Server "one" was last deployed by MUP with privateDockerRegistry: its start.sh pulls :latest from the registry, so a rollback would not change the version. Run "comet-deploy reconfig" first, then the rollback.
```

MUP's `start.sh` with a registry pulls `<imagePrefix>/mup-<name>:latest` on every start, so any image a rollback tagged on the server would be replaced by the registry's. `comet-deploy reconfig` writes comet-deploy's `start.sh` (it first tags `mup-<name>:latest` to the image that runs, so nothing changes for the app), and then `rollback` works. The other servers of the rollback are not affected.

### Health check failed and the server was reverted

```
[one] health ✗ Health check failed: no healthy answer within 60s, last HTTP 502
[one] revert ↺ previous version restored, HTTP 200 after 4s
<== Activate (1m12s)

SERVER  VERSION                  RESULT    TIME   NOTE
one     20261111-091502-3f2a1c9  reverted  1m11s  Health check failed: no healthy answer within 60s, last HTTP 502
two     -                        skipped   -      not deployed (an earlier server failed)

Last log lines on "one":
…
Error: Deploy of 20261111-091502-3f2a1c9 did not complete on: one, two
```

The new version did not answer in time, so the server went back to the previous version, which answers again. With the `canary` strategy the other servers are skipped and keep the old version. The command exits with code 1.

Read the log lines first (or `comet-deploy logs --tail 200`). Then:

| Message | Likely cause | What to do |
|---|---|---|
| `the container stopped or is restarting` | The app crashes at start: a wrong `MONGO_URL`, a missing env variable or setting, an exception at startup. | Read the logs and fix the app or the config. |
| `no healthy answer within 60s` | The app starts slowly, listens on another port, or does not answer HTTP. | Raise `app.deployCheckWaitTime`. Check `docker.imagePort` (default 3000) and `app.deployCheckPort`. |
| `…, last HTTP 500` (or another 5xx) | The app answers, but with a server error on the checked path. | Fix the error, or point `cometDeploy.healthCheck.path` at a route that returns 2xx–4xx when the app is up. MUP accepts a 5xx; to do the same, set `cometDeploy.healthCheck.maxStatus: 599`. |
| `the container got no IP address` | The container network is unusual (custom `docker.args` or `networks`). | Check `docker.args` and `docker.networks`. |

The check runs on the server: it calls `http://<container IP>:<deployCheckPort><healthCheck.path>` with `curl`. You can try the same by hand:

```bash
ssh root@192.0.2.10
IP=$(sudo docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' myapp)
curl -sS -o /dev/null -w '%{http_code}\n' "http://$IP:3000/"
```

### The restored version is not healthy either

```
[one] revert ✗ previous version restored, but no healthy answer within 60s
```

The new version failed, and the old version does not answer either after the revert. The result is `failed`. Usually the problem is outside the app image: the database is down, the server is out of memory, or something else uses the port. Check `comet-deploy logs`, `comet-deploy status` and the server, fix the cause, then deploy again or run `comet-deploy rollback`.

### Mixed versions after a partial failure

```
Warning: MIXED VERSIONS: one run 20261111-091502-3f2a1c9; two do not. Fix the problem and deploy again,
or run "comet-deploy rollback --servers one" to return those servers to the previous version.
```

Some servers run the new version and others do not. This happens when the canary passed but a later server failed, or with the `rolling` strategy. The summary table shows each server's result: `ok`, `reverted`, `failed`, or `skipped` (`not deployed (an earlier server failed)`).

You have two options:

1. **Go forward.** Fix the problem on the failed servers and run `comet-deploy deploy` again. If the code did not change, the build is skipped and the same image is activated on all servers.
2. **Go back.** Run the `rollback` command from the message to return the healthy servers to the previous version.

`comet-deploy status` shows which version runs where, and `comet-deploy history` shows the result per server.

### Nothing to roll back to

```
Nothing to roll back to: no older version and no :previous image on this server
Version 20261101-120000-1a2b3c4 is not on this server. Available: …
```

`rollback` only uses images that are still on the server. comet-deploy keeps `cometDeploy.keepVersions` versions (default 5) and removes versions that never ran healthy on that server. `comet-deploy history` lists the version names. To go further back, check out the old commit and deploy it.

### Leftover local images and the registry volume

What stays on your machine:

- **Local images.** Every build creates an image `mup-<name>:<version>` (for several platforms with an `-amd64` / `-arm64` suffix). The build cache remembers the last 20 builds per app; when it forgets one, it removes that build's image (`docker rmi`, best effort: an image that is still in use stays). So at most about 20 images per app remain. To remove more by hand:

  ```bash
  docker images mup-myapp
  docker rmi mup-myapp:20261101-120000-1a2b3c4
  ```

  When nothing changed (`No changes since …`) or with `--cached-build`, a deploy reuses one of these images. If you removed it, the next deploy builds again.

- **The registry volume.** The local registry keeps every pushed layer in the Docker volume `comet-deploy-registry-data`. comet-deploy never cleans it, so it grows with every deploy.

To reset the registry (when no deploy is running):

```bash
docker rm -f comet-deploy-registry
docker volume rm comet-deploy-registry-data
```

The next deploy creates both again and pushes the full image once. The servers are not affected: they keep their own copies of the layers.

To clear the BuildKit cache (the next build runs `npm install` again): `docker builder prune`.

## Hooks

### A hook failed

```
Error: Hook "pre.default.deploy" failed: "npm test" exited with code 1.
Error: Hook "post.meteor.start" failed: notify failed
```

A failing `localCommand` or `method` fails its step: the step (for a `pre.` hook) and every later step do not run, and no other hook runs. The deploy locks are always released. What the servers run depends on where the hook was:

- **before the activation** (`pre.default.deploy` to `pre.meteor.start`): nothing changed on the servers, the old version still runs;
- **after the activation** (`post.meteor.start`, `post.default.reconfig` and later): the new version runs and the deploy history has it, but old versions were not pruned; the next deploy does that.

Run the command from the hook by hand in the config directory to see why it failed. With `--verbose`, a failing `method` also prints its stack trace.

### A remote command failed but the deploy went on

```
Warning: Hook "post.default.deploy": the remote command exited with code 3 on server "one".
```

As in MUP, a `remoteCommand` never fails the command. For a check that must stop the deploy, use a `localCommand` that runs `ssh` itself, or a `method` that checks `code`:

```js
'pre.meteor.start': async (api) => {
  for (const server of Object.values(api.getConfig().servers)) {
    const r = await api.runSSHCommand(server, '/opt/check.sh');
    if (r.code !== 0) throw new Error(`check failed on ${r.host}: ${r.output}`);
  }
},
```

### A hook never runs

`comet-deploy validate` warns about a name that does not match a step (`hooks."pre.deplyo" does not match a command, so it never runs`), a name without `pre.` or `post.`, and a hook on a command comet-deploy does not have (`default.ssh`, `meteor.debug`, …). Run the command with `--show-hook-names` to see every name it enters, in order. A name with one dot is short for `default`: `pre.deploy` is `pre.default.deploy`, and it runs only for `deploy`, not for `meteor deploy`. See [Configuration → Keys and nesting](configuration.md#keys-and-nesting).

### api.runCommand cannot run while comet-deploy holds the deploy lock

```
Error: api.runCommand("default.restart") cannot run while comet-deploy holds the deploy lock (from a hook inside a locked step). Run it from a post.default.deploy hook instead.
```

The hook runs while the command holds the deploy lock (in `deploy`, from `pre.meteor.prepareBundle` to `post.default.reconfig`), and the command it calls would take the same lock again. Move the hook to `post.default.deploy` or `post.meteor.deploy`, which run after the unlock.

### api.getSessions() is not supported

```
Error: Hook "pre.default.deploy" failed: api.getSessions() is not supported by comet-deploy (it needs MUP's nodemiral sessions). Use api.runSSHCommand(server, command) or a remoteCommand hook.
```

comet-deploy has no nodemiral sessions. Run the remote part with `api.runSSHCommand(server, command)`, which resolves with `{ code, output, host }`, or as a `remoteCommand`. The list of what the api object has is in [Configuration → The api object](configuration.md#the-api-object).

## MongoDB

### MongoDB is not running

```
Preflight failed:
  - Server "one": MongoDB (container "mongodb") is not running. Start it with: comet-deploy mongo start
```

The config has a `mongo` section, so the app container is linked to the `mongodb` container, and Docker cannot start the app without it. `deploy` stops before the build; `reconfig`, `restart`, `rollback` and `start` stop with the same message before they touch the app.

- `Start it with: comet-deploy mongo start`: MongoDB was set up but is stopped (for example after `mongo stop`). `comet-deploy mongo logs --tail 50` shows why it stopped on its own.
- `Set it up with: comet-deploy setup`: `/opt/mongodb/mongo-start-new.sh` is missing on the server, so `mongo setup` never ran there.
- Instead of a hint, the reason the built-in MongoDB cannot run with this config (`MUP's built-in MongoDB needs exactly one app server …`, or `… must run on the app's server …`). Use your own database: set `app.env.MONGO_URL` and remove the `mongo` section.

### A MongoDB version change is refused

```
Error: mongo setup failed on 1 server(s):
  - one: MongoDB 5.0.31 → 7.0.14 skips a release series: MongoDB upgrades one release series at a time (5.0 → 6.0 → …), with the featureCompatibilityVersion raised after each step. See https://www.mongodb.com/docs/manual/release-notes/
To change the version anyway (for example with an empty dataPath), add --allow-mongo-version-change.
```

`mongo.version` changed in a way the data in `dataPath` cannot follow, and MongoDB would restart forever on it. Nothing was written: the container and `/opt/mongodb` are as before. Upgrade one release series at a time, as in [Configuration → Upgrading MongoDB](configuration.md#upgrading-mongodb). The other refusals:

- `goes to an older release series`: put the old `version` back. A downgrade needs the featureCompatibilityVersion lowered first and is best done from a backup.
- `the data's featureCompatibilityVersion is 5.0; upgrading to 7.0 needs 6.0`: raise the FCV first, with the command in the message (`comet-deploy mongo shell`, then `db.adminCommand({ setFeatureCompatibilityVersion: "6.0" })`).
- `could not read the featureCompatibilityVersion of the running MongoDB (is it running?)`: start it with the old version (`comet-deploy mongo start`) and run `setup` again.

`--allow-mongo-version-change` turns the refusal into a warning, for an empty `dataPath` that you fill from a backup afterwards.

### Before the next MongoDB upgrade

```
[one] Before the next MongoDB upgrade, set the feature compatibility version: comet-deploy mongo shell, then db.adminCommand({ setFeatureCompatibilityVersion: "7.0", confirm: true })
```

An upgrade to the next release series worked, and the data still has the old series' featureCompatibilityVersion, so MongoDB can still go back to the old version. When the app works with the new one, raise it as shown. `comet-deploy mongo status` shows the current value (`Feature compatibility:`).

### MongoDB version change not checked

```
Warning: [one] MongoDB 7.0.14 → latest: the version change was not checked (comet-deploy checks only plain versions of the release series it knows). Make sure the new version can open the data.
```

The version is not `major.minor[.patch]` of a release series comet-deploy knows (for example `latest`, `7` or a rapid release such as `7.3`), so the change goes ahead as with MUP. Prefer a full version such as `7.0.14`, which also keeps the server from moving to a new release on its own.

## The reverse proxy

### The reverse proxy is not set up

```
Preflight failed:
  - Server "one": the reverse proxy is not set up (container mup-nginx-proxy is missing or stopped). Run "comet-deploy proxy setup" first.
```

The config has a `proxy` section, but the proxy container does not run on that proxy server. MUP would deploy the app anyway, and nobody could reach it; comet-deploy stops before the build. `reconfig`, `restart` and `rollback` stop the same way (`The reverse proxy is not ready:`), with `Nothing was changed.`

- A new server, or the proxy was never set up: `comet-deploy proxy setup` (or `comet-deploy setup`, which includes it).
- The proxy was set up but is stopped (for example after `proxy stop`): `comet-deploy proxy start`.
- `comet-deploy proxy status` shows both proxy containers per server.

### A server stays out of load balancing

```
Warning: "two" stays out of load balancing because it did not end healthy. Once it is healthy, run "comet-deploy restart --servers two" to put it back.
```

and in `status` or `proxy status`:

```
   - Drained: two (run "comet-deploy restart --servers two" once it is healthy)
```

With `proxy.loadBalancing`, a server is taken out of the upstream (`down` in `/opt/mup-nginx-proxy/upstream/<app>`) before its app restarts, and goes back in after its health check. It stays out when it did not end healthy: its restored version failed too (`revert-failed`), or the command did not finish on it (a lost connection, a killed process). The other servers keep serving. comet-deploy never takes the last server out.

1. Find out why: `comet-deploy status`, `comet-deploy logs --tail 100 --servers two`.
2. Fix the cause. If the app on that server is healthy already, go to step 3; otherwise deploy a working version: `comet-deploy deploy --servers two`.
3. `comet-deploy restart --servers two`. After a healthy restart the server goes back into the upstream on every proxy, and `Drained:` disappears.

`setup` and `proxy setup` keep the server out, so they do not send traffic to a broken server. MUP's own `mup proxy setup` clears the mark and puts the server back whether it is healthy or not.

### Zero-downtime switch not used

```
Zero-downtime switch not used: docker.args publishes a host port, which two containers cannot share
```

This is information, not an error. Behind the proxy, comet-deploy normally starts the new container beside the old one. When the config makes that unsafe, the server restarts in place, as with MUP, and the line says why:

| Reason | What you can do |
|---|---|
| `cometDeploy.zeroDowntime is false` | Remove the option, if you want the switch. |
| `proxy.loadBalancing is on: …` | Nothing: load-balanced servers are taken out of the upstream instead. |
| `docker.args publishes a host port …` | Remove `-p`/`--publish` from `docker.args`. The proxy reaches the app over the Docker network; a published port is only needed if something else connects to it directly. |
| `docker.args uses the host network …`, `docker.networks includes the host network` | Use a bridge network. |
| `docker.args sets --name …` | Remove `--name`: MUP names the container after the app. |

### The shared proxy settings differ

```
Warning: The shared proxy settings (proxy.shared) differ from the ones on one. A deploy does not apply them, because that restarts the proxy for every app on the server. Run "comet-deploy proxy reconfig-shared" to apply them.
```

`proxy.shared` configures the proxy itself, for every app on the server, so a deploy only reports the difference. `comet-deploy proxy reconfig-shared` applies it and restarts the proxy, which interrupts every app on the server for a moment.

If several apps share the proxy, keep the `shared` section in the config of only one of them: `reconfig-shared` from an app without `shared` resets the proxy to MUP's defaults. A config without `shared` never shows this warning.

### Load balancing was not enabled

```
Warning: loadBalancing was not enabled on the proxies because two did not deploy; run the deploy again
```

When `proxy.loadBalancing` changes from `false` to `true`, the upstream is written only after every server runs the new container, which publishes `app.env.PORT`. Until then nginx keeps routing to the containers as before, so nothing is broken; fix the server that failed and run `comet-deploy deploy` again.

On the next deploy, a server whose container already publishes the port is restarted in place (`[two] the running container already publishes the load balancing port: restarting it in place`), so expect a short gap on that server.

Turning load balancing off removes the upstream before the servers are activated, and every server then switches without a gap.

### Updating the reverse proxy failed

```
Updating the app's proxy files failed:
  - Server "one": …
Hint: The app was not restarted on any server.
```

The app's proxy files are written before any server is activated. If that fails, the command stops, and the app keeps running everywhere as before. Fix the cause shown for each server and run the command again.

A file named in the config that cannot be read locally (`ssl.crt`, `ssl.key`, `nginxServerConfig`, `nginxLocationConfig`) stops the command even earlier, before the build: `Cannot read proxy.ssl.crt (<path>): …`. The paths are relative to the config's directory.

```
Warning: Could not update the reverse proxy on "one": connect ETIMEDOUT. Its upstream may still have two out of load balancing: once "one" is reachable, run "comet-deploy restart --servers two".
```

This one comes at the end, after the servers were activated: the upstream on that proxy server could not be written, also not in the last try at the end of the command, so it may still have a server marked `down`. When the proxy server is reachable again, `comet-deploy restart --servers two` restarts `two` and, once it is healthy, writes the upstream on every proxy server. (`proxy setup` would keep the `down` mark.)

```
Warning: Could not update the reverse proxy on "one": …. Run "comet-deploy proxy setup" once it is reachable.
```

Here no server is out of load balancing because of it, but other proxy files of the app (turning load balancing on, its links or its config container) were not written. `comet-deploy proxy setup` writes them; to turn load balancing on, run `comet-deploy deploy` again.

```
Warning: "three" is not in load balancing: it does not run this config yet. Run "comet-deploy deploy --servers three" to add it.
```

A new server, or a server whose `privateIp` or `host` changed, joins the upstream only once it is healthy with the new config. It did not get there in this run (it failed, was reverted or was not selected); fix it and deploy it again.

### A load-balanced server is down for longer

With `proxy.loadBalancing`, `deploy`, `reconfig`, `restart` and `rollback` lock every app server and read the proxy on every proxy server, also with `--servers`, because they all share one upstream. A server that cannot be reached therefore stops them (`Cannot connect …`, or `The reverse proxy is not ready:`), even `restart --servers` of a healthy server.

If the server stays down for a while, take it out of the config: remove it from `app.servers` (and from `proxy.servers`, if it is listed there) and run `comet-deploy deploy`. The deploy removes it from the upstream on the other proxy servers, so nginx stops sending requests there. When the server is back, add it to the config again and deploy: it joins the upstream once it is healthy.

### No Let's Encrypt certificate

The companion `mup-nginx-proxy-letsencrypt` gets the certificates, as with MUP. It needs every domain in `proxy.domains` to point at the proxy server, and port 80 to be reachable from the internet.

- `comet-deploy proxy logs-le --tail 100` shows what it tried.
- `comet-deploy proxy status` lists the certificates and their expiry dates.
- After a change of `proxy.domains`, run `comet-deploy deploy`: the app's container gets the new `LETSENCRYPT_HOST`.
