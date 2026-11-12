# Deploying from CI

comet-deploy works the same in a CI job as on your machine: the job builds the image once, and every server gets only the layers it does not have yet. This page lists what the job needs, explains how the build cache survives between CI runs, and has a complete GitHub Actions workflow.

## What the job needs

| What | Why |
|---|---|
| Node.js 20 or newer | to run comet-deploy (`npm install -g comet-deploy`) |
| Docker with buildx | the image is built on the runner |
| The Meteor tool | `meteor build` runs on the runner; it downloads the release in `.meteor/release` |
| The app's npm dependencies | `meteor npm ci` before the deploy, as for any `meteor build` |
| An SSH private key for the servers | from a CI secret, written to a file that `servers.<name>.pem` points to |
| The config and the secrets | `mup.js` can read secrets from environment variables (`process.env.MONGO_URL`); a `settings.json` with secrets can be written from a CI secret |
| A runner with the servers' CPU architecture, or emulation | an `x86_64` runner builds for `x86_64` servers natively; for `aarch64` servers use an arm64 runner, or QEMU emulation (slow when the dependencies change) |

The servers need nothing new: the image still travels through an SSH reverse tunnel from the runner.

## The build cache between runs

On your machine, BuildKit keeps the layers of earlier builds. When the app's dependencies did not change, the `npm install` layer is a cache hit, it is the same layer the servers already have, and only the app code travels.

A fresh CI runner has no BuildKit cache. Without one, every deploy runs `npm install` for all dependencies again, and the result is a new layer, even though nothing changed: every server downloads all dependencies again, which is often hundreds of MB.

`--cache-to` and `--cache-from` keep the cache between runs. They take the same values as for `docker buildx build`:

- `--cache-to <spec>` exports the build cache after the build,
- `--cache-from <spec>` imports it before the build.

With the imported cache, the `npm install` step is a cache hit again (`CACHED` in the `--verbose` output). The layer is the one the servers already have, so they get only the app code, the same as for a deploy from your machine.

Where the cache can go:

| Cache type | Where | Example |
|---|---|---|
| `gha` | the GitHub Actions cache | `--cache-from type=gha,scope=myapp --cache-to type=gha,mode=max,scope=myapp` |
| `registry` | an image in a registry the runner can push to | `--cache-from type=registry,ref=registry.example.com/myapp:buildcache --cache-to type=registry,ref=registry.example.com/myapp:buildcache,mode=max` |
| `local` | a directory, kept by the CI service's own cache | `--cache-from type=local,src=.buildcache --cache-to type=local,dest=.buildcache-new,mode=max` |

Things to know:

- **Exporting needs a buildx builder that supports it.** The default `docker` driver supports cache exports only with Docker's containerd image store. Otherwise create a builder with the `docker-container` driver first (`docker buildx create --use`; in GitHub Actions, `docker/setup-buildx-action`). Without one, the build fails with `Cache export is not supported for the docker driver`.
- **One cache per app and per CPU architecture.** A new export replaces the old one with the same name (the `scope` of `gha`, the `ref` of `registry`). If the servers have different CPU architectures, a deploy builds one image per architecture with the same `--cache-to`, and the last one wins. Deploy each architecture in its own job with `--servers` and a cache name of its own.
- **A `local` cache directory only grows.** Export into a new directory (`dest=.buildcache-new`) and replace the old one after the deploy, as in [Docker's guide](https://docs.docker.com/build/cache/backends/local/).
- Without `--cache-from` the deploy still works; it is only slower and ships the dependencies again.

comet-deploy also skips the build when nothing in the app changed since an earlier build (`No changes since …`). That check uses local state in `~/.cache/comet-deploy`, so on a fresh runner every deploy builds. The build cache makes that build fast.

## GitHub Actions

### The config

A `mup.js` for CI reads the secrets from the environment. The key file is the one the workflow writes:

```js
module.exports = {
  servers: {
    one: { host: '203.0.113.10', username: 'deploy', pem: '~/.ssh/deploy_key' },
  },
  app: {
    name: 'myapp',
    path: '../',
    servers: { one: {} },
    docker: { image: 'zodern/meteor:root' },
    env: {
      ROOT_URL: 'https://app.example.com',
      MONGO_URL: process.env.MONGO_URL,
    },
  },
};
```

The same file works on your machine with `MONGO_URL` set in your shell.

### The workflow

`.github/workflows/deploy.yml` in the app's repository, for an app with its config in `.deploy/`:

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

# One deploy at a time: a second run waits instead of failing on the deploy lock.
concurrency:
  group: deploy-production
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest # x86_64 servers; use ubuntu-24.04-arm for aarch64 servers
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: 24

      - name: Cache the Meteor tool
        uses: actions/cache@v6
        with:
          path: ~/.meteor
          key: meteor-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('.meteor/release') }}

      - name: Install Meteor
        run: |
          [ -x "$HOME/.meteor/meteor" ] || curl -fsSL https://install.meteor.com/ | sh
          echo "$HOME/.meteor" >> "$GITHUB_PATH"

      - name: App dependencies
        run: meteor npm ci

      # A builder with the docker-container driver, which can export the build cache.
      - uses: docker/setup-buildx-action@v4

      # The GitHub cache service variables, which `type=gha` needs outside docker's own actions.
      - uses: crazy-max/ghaction-github-runtime@v4

      - name: SSH key
        env:
          DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
        run: |
          install -m 700 -d ~/.ssh
          printf '%s\n' "$DEPLOY_SSH_KEY" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key

      - name: Install comet-deploy
        run: npm install -g comet-deploy@0.1.0

      - name: Deploy
        working-directory: .deploy
        env:
          MONGO_URL: ${{ secrets.MONGO_URL }}
        run: >-
          comet-deploy deploy
          --cache-from type=gha,scope=myapp
          --cache-to type=gha,mode=max,scope=myapp
```

Notes:

- **Secrets.** Add `DEPLOY_SSH_KEY` (the private key, whose public key is in the deploy user's `~/.ssh/authorized_keys` on every server) and `MONGO_URL` under the repository's Settings → Secrets and variables → Actions. comet-deploy masks the `env` values (except public ones such as `ROOT_URL`) and the settings values in its output.
- **Settings with secrets.** Commit a `settings.json` without secrets, or write it in a step from a secret, the same way as the key, and point to it with `--settings`.
- **Pin the version** of comet-deploy (`comet-deploy@0.1.0`), so a new release changes your deploys only when you change the workflow.
- **Cache scope.** A run can read the caches of its own branch, of the base branch of a pull request, and of the default branch. Use one `scope` per app and environment.
- **Docker Hub.** The build pulls the base image (`zodern/meteor`) from Docker Hub. Many runs from shared runner IPs can hit Docker Hub's rate limit for anonymous pulls; `docker/login-action` with a Docker Hub account avoids it.
- **A cancelled run** stops the deploy at the next safe point, as Ctrl+C does (see [Commands → Graceful abort](commands.md)). If the runner is killed without that, the deploy lock stays; `comet-deploy unlock` releases it.
- **SSH host keys** are not checked, the same as with MUP, so the job needs no `known_hosts`.

## Other CI services

The same steps apply anywhere: Node.js, Docker with buildx, the Meteor tool, `meteor npm ci`, the SSH key, then `comet-deploy deploy` with a build cache that survives between runs.

- **GitLab CI.** A job with access to a Docker daemon (a shell runner with Docker, or the `docker:dind` service). The project's container registry suits `type=registry` (`--cache-from type=registry,ref=$CI_REGISTRY_IMAGE:buildcache`, with `docker login` to `$CI_REGISTRY` first). Create a `docker-container` builder for the export.
- **Any CI with a directory cache.** `type=local` into a directory that the service saves and restores between runs.
- **Your own runner.** A runner that keeps its Docker state between jobs keeps BuildKit's cache too, the same as your machine, and needs no `--cache-from` / `--cache-to`.
