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
- [Timed out waiting for the registry lock](#timed-out-waiting-for-the-registry-lock)
- [Health check failed and the server was reverted](#health-check-failed-and-the-server-was-reverted)
- [The restored version is not healthy either](#the-restored-version-is-not-healthy-either)
- [Mixed versions after a partial failure](#mixed-versions-after-a-partial-failure)
- [Nothing to roll back to](#nothing-to-roll-back-to)
- [Leftover local images and the registry volume](#leftover-local-images-and-the-registry-volume)

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

```
Server "one": SSH reverse port forwarding does not work (<reason from the server>). comet-deploy sends the image through it:
set "AllowTcpForwarding yes" in /etc/ssh/sshd_config and reload sshd.
```

comet-deploy sends the image layers through an SSH reverse tunnel: the server pulls from `127.0.0.1:<port>`, which leads back to a registry on your machine. Preflight opens and closes such a tunnel on every server before the build, so this is reported early.

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

A transfer that does not need forwarding (`cometDeploy.transfer: 'stream'`) is planned for phase 2.

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
Hook "pre.deploy" is not supported yet (hooks are planned for phase 2 of comet-deploy).
"mongo shell" is not supported yet: it is planned for phase 2 of comet-deploy.
```

The `mongo`, `privateDockerRegistry` and `hooks` parts of a MUP config, and the `mongo`, `ssh` and `meteor debug` commands, are phase 2. Remove the part from the config if you do not need it, or keep using MUP for that app. See [Configuration → Planned for phase 2](configuration.md#planned-for-phase-2) and [Migrating from MUP](migrating-from-mup.md#check-first-what-does-not-work-yet).

Hooks are checked before the command does anything: a hook on any step the command will run, for example `pre.meteor.start` for `deploy`, stops it before preflight and the build. Nothing changes on the servers.

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

A server could not pull the image. All servers keep their old version, because activation starts only after every server has the image. Common causes: a full disk on the server, a network problem, Docker not running. Fix it and deploy again; the build is skipped if nothing changed.

### Timed out waiting for the registry lock

```
Timed out waiting for /home/jane/.cache/comet-deploy/registry-leases.lock (held by process 4242)
Hint: Another comet-deploy is starting or stopping the local registry. If none is running, delete the file.
```

All deploys on your machine share one local registry. A short lock file makes starting and stopping it safe when several deploys run at once. A lock left by a process that no longer runs is taken over automatically; this error comes only after 120 seconds of waiting for a live process. If no other comet-deploy is running, delete the file and deploy again.

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
