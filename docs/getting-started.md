# Getting started

[README](../README.md) · **Getting started** · [Configuration](configuration.md) · [Commands](commands.md) · [How it works](how-it-works.md) · [Migrating from MUP](migrating-from-mup.md) · [Troubleshooting](troubleshooting.md)

This guide takes a Meteor app from nothing to a running deploy on one server: install, `init`, `setup`, `deploy`, and checks that it works.

Already deploy with Meteor Up? Skip to [Migrating from MUP](migrating-from-mup.md): your `mup.js` works as it is, and servers set up by MUP need no `setup`.

- [Requirements](#requirements)
- [1. Install comet-deploy](#1-install-comet-deploy)
- [2. Create the config](#2-create-the-config)
- [3. Validate](#3-validate)
- [4. Set up the server](#4-set-up-the-server)
- [5. Deploy](#5-deploy)
- [6. Check that it works](#6-check-that-it-works)
- [7. The next deploys](#7-the-next-deploys)
- [Next steps](#next-steps)

## Requirements

### On your machine

| What | Why | Check |
|---|---|---|
| Node.js 20 or newer | runs comet-deploy | `node --version` |
| Meteor (the version your app uses) | `meteor build` runs locally | `meteor --version` |
| Docker with BuildKit and buildx: Docker Desktop, OrbStack, or Docker Engine on Linux | the image is built locally | `docker version` and `docker buildx version` |
| git (optional) | the commit goes into the version tag and the history | `git --version` |

**Docker on your machine is new compared to MUP.** MUP builds the Docker image on each server; comet-deploy builds it once, locally.

The buildx builder must be able to build for your servers' platform. Most servers are `linux/amd64`:

```bash
docker buildx inspect | grep Platforms
# Platforms: linux/arm64, linux/amd64, linux/amd64/v2, ...
```

On an Apple Silicon Mac, `linux/amd64` needs emulation. Docker Desktop: Settings → General → "Use Rosetta for x86_64/amd64 emulation on Apple Silicon". See [Troubleshooting](troubleshooting.md#building-on-an-arm64-mac-for-amd64-servers).

macOS and Linux are supported. On Windows, use WSL2 (not tested).

### On the server

The same as for MUP:

| What | Notes |
|---|---|
| Linux, `x86_64` or `aarch64` | `setup` installs Docker with `apt-get` and `get.docker.com`, so Debian or Ubuntu for `setup`. With Docker already installed, any distribution with bash works. |
| SSH access | key (`pem`), password, or ssh agent |
| `root`, or a user with **passwordless sudo** | every remote command runs through `sudo` |
| `bash`, `sudo`, `curl` | `curl` is used by the health check; `setup` installs it when it installs Docker |
| Docker 18 or newer | `setup` installs it |
| SSH TCP forwarding allowed | `AllowTcpForwarding yes` in `/etc/ssh/sshd_config`, which is the OpenSSH default |

A quick check from your machine (replace user and address):

```bash
ssh root@192.0.2.10 'uname -m; sudo -n true && echo "sudo ok"'
```

You also need a MongoDB that the server can reach (for example a managed MongoDB or your own replica set). MUP's built-in MongoDB (`mongo` section) is planned for phase 2.

## 1. Install comet-deploy

comet-deploy is not on npm yet. Install it from source:

```bash
git clone https://github.com/mfeuermann/meteor-deploy.git
cd meteor-deploy
npm ci
npm run build
npm link
```

`npm link` puts the `comet-deploy` command on your `PATH` (it points to `dist/cli/main.js` in the clone). Check it:

```bash
comet-deploy --version
# 0.1.0
```

After a `git pull`, run `npm ci && npm run build` again.

Once the package is published, this will be:

```bash
npm install -g comet-deploy
```

## 2. Create the config

Go to your Meteor app and run `init`:

```bash
cd ~/code/myapp
comet-deploy init
```

```
Created .deploy folder
Created settings.json at /home/jane/code/myapp/.deploy/settings.json
Created mup.js at /home/jane/code/myapp/.deploy/mup.js

Next steps:
  Open mup.js and edit the config to meet your needs.
  Required changes have been marked with a TODO comment.
  The config format is the same as Meteor Up (https://github.com/zodern/meteor-up).
  Then run: comet-deploy setup
```

`init` creates the same files as `mup init`. Run `comet-deploy init --json` to get `mup.json` instead. Where the files go when you run `init` elsewhere: [Commands → init](commands.md#init).

Open `.deploy/mup.js` and change it:

1. **`servers.one`**: your server's `host`, `username`, and one of `pem` (path to the private key), `password`, or nothing (ssh agent).
2. **`app.name`**: a name without spaces. It names the container, `/opt/<name>` and the image on the server.
3. **`app.env.ROOT_URL`**: the URL of your app.
4. **`app.env.MONGO_URL`**: your database. Delete `MONGO_OPLOG_URL`, or point it at your database's `local` database if you use oplog tailing.
5. **Delete the `mongo` section.** It sets up MUP's built-in MongoDB, which comet-deploy does not run yet; `deploy` refuses a config that has it.
6. Keep `docker.image: 'zodern/meteor:root'`. comet-deploy needs an image that can build an app image (`zodern/meteor` or `abernix/meteord`).

The result looks like this:

```js
module.exports = {
  servers: {
    one: {
      host: '192.0.2.10',
      username: 'root',
      pem: '~/.ssh/id_ed25519',
    },
  },

  app: {
    name: 'myapp',
    path: '../',

    servers: {
      one: {},
    },

    buildOptions: {
      serverOnly: true,
    },

    env: {
      ROOT_URL: 'http://app.example.com',
      MONGO_URL: 'mongodb://myapp:secret@db.example.com:27017/myapp',
    },

    docker: {
      image: 'zodern/meteor:root',
    },
  },
};
```

The app is published on port 80 of the server (`app.env.PORT`, default 80). comet-deploy does not set up TLS in this release; for `https://`, put your own reverse proxy or load balancer in front of it.

`settings.json` next to `mup.js` is your Meteor settings file. It reaches the app as `METEOR_SETTINGS`.

All options: [Configuration](configuration.md). Optional comet-deploy options (strategy, health check, kept versions) go into a `cometDeploy` section: [Configuration → cometDeploy](configuration.md#cometdeploy).

## 3. Validate

Run all commands from the folder with `mup.js`:

```bash
cd .deploy
comet-deploy validate
```

```
✓ Config is valid
```

`validate` exits with code 1 on any problem, warnings included. Other commands stop only on errors and print warnings. To see the config with all defaults filled in, run `comet-deploy validate --show`.

## 4. Set up the server

```bash
comet-deploy setup
```

```
==> Docker setup
[one] docker setup →
[one] docker setup ✓
<== Docker setup (48.2s)
==> App setup
[one] app setup →
[one] app setup ✓
<== App setup (0.6s)

Next, deploy the app with: comet-deploy deploy
```

`setup` installs Docker if it is missing or older than 18, starts it, and creates `/opt/myapp/{config,tmp}` owned by the SSH user. It runs on all servers in parallel. Add `--verbose` to see the output of the remote scripts.

## 5. Deploy

```bash
comet-deploy deploy
```

What happens:

1. **Preflight** checks your machine (Docker, buildx platforms, Meteor) and the server (SSH, sudo, Docker, CPU architecture, disk space, that `setup` ran, port forwarding, lock), and reports all problems before building.
2. **Build** runs `meteor build` and `docker buildx build` locally. The first build takes as long as `npm install` of your app takes; later builds reuse the dependency layer.
3. **Lock** takes the deploy lock on the server.
4. **Distribute** sends the image to the server through an SSH tunnel. The first time this is the whole image; the server pulls the base image from Docker Hub itself.
5. **Activate** restarts the container with the new image and checks that the app answers over HTTP. If it does not, the previous version comes back automatically.

```
==> Preflight
<== Preflight (1.8s)
==> Build
==> meteor build (linux/amd64)
<== meteor build (linux/amd64) (62.4s)
==> docker build (linux/amd64)
<== docker build (linux/amd64) (71.0s)
<== Build (2m16s)
==> Lock
<== Lock (0.4s)
==> Distribute
[one] distribute →
[one] distribute ✓ 38.7s
<== Distribute (40.1s)
==> Activate
[one] activate →
[one] health ✓ HTTP 200 after 6s
<== Activate (12.3s)

SERVER  VERSION                  RESULT  TIME   NOTE
one     20261111-091502-3f2a1c9  ok      12.3s

Deployed 20261111-091502-3f2a1c9 to one.
```

The version is the UTC time of the deploy plus the short git commit of the app (`-dirty` if the work tree has uncommitted changes).

If something fails, the error says what and usually how to fix it. See [Troubleshooting](troubleshooting.md).

## 6. Check that it works

```bash
comet-deploy status
```

```
SERVER  DOCKER  APP      VERSION                  HTTP  LOCK
one     27.5.1  running  20261111-091502-3f2a1c9  200
```

Open the app:

```bash
curl -I http://192.0.2.10/
```

Read the logs (options go to `docker logs`):

```bash
comet-deploy logs --tail 50
comet-deploy logs -f
```

See the deploy history:

```bash
comet-deploy history
```

## 7. The next deploys

Change some code and deploy again:

```bash
comet-deploy deploy
```

This time `meteor build` runs again, but the `npm install` layer comes from the cache, and the server receives only the layers with the changed code. Activation is the same.

| You changed | What to run | What happens |
|---|---|---|
| App code | `comet-deploy deploy` | Build with the cached dependency layer; only the changed layers travel. |
| npm dependencies | `comet-deploy deploy` | The dependency layer is rebuilt and sent once. |
| Nothing | `comet-deploy deploy` | `No changes since <version>`: no build, the same image is activated again. |
| Only `env` or `settings.json` | `comet-deploy reconfig` | No build, no transfer: new `env.list`, restart, health check. |
| A deploy went wrong | `comet-deploy rollback` | Back to the previous kept version, in seconds. |

With more servers, add them to `servers` and `app.servers`. With the default `canary` strategy, the first server in `app.servers` is activated first; the others follow in parallel only if it is healthy.

## Next steps

- [Configuration](configuration.md): every option, and the `cometDeploy` section.
- [Commands](commands.md): every command and flag.
- [How it works](how-it-works.md): build cache, distribution, health check, revert, locks, history.
- [Troubleshooting](troubleshooting.md): common errors and fixes.
