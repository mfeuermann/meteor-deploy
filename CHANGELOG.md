# Changelog

All notable changes to comet-deploy. The versions follow [semantic versioning](https://semver.org); before 1.0.0, a minor version can change behavior, and this file says how. Each version is on npm as [`comet-deploy`](https://www.npmjs.com/package/comet-deploy) and on GitHub as a release.

## [Unreleased]

### Changed

- The certificate check after `deploy`, `reconfig` and `proxy setup` also warns, like `status`, when your `proxy.ssl.crt` expires within 14 days, has expired or is not for a domain of the app (`"one": proxy.ssl.crt is not for www.example.com (CN=example.com). Add the domain to the certificate, or remove it from proxy.domains.`). Before, it only compared the certificate with the one nginx serves.
- The check prints `[<server>] waiting up to 30 s until nginx serves proxy.ssl.crt` while it waits, instead of a silent pause before the summary.
- A deploy that was aborted, or that ended healthy on no server, skips the check: it failed, and the next deploy checks again. Ctrl+C while the check waits stops the wait too.

## [0.7.0] - 2026-11-17

Certificates behind the proxy: what nginx serves for each domain, checked after a deploy, and the switch from Let's Encrypt to your own certificate that no longer loses it.

### Added

- With `proxy.ssl`, `status` and `proxy status` show the certificate nginx actually serves for each domain of the app (`Served certificates`), asked on each proxy server: the issuer, the expiry date and the days left, or `proxy.ssl.crt` for your own certificate. They warn about a certificate that expires within 14 days or has expired, one that is not for the domain, one that is not your `proxy.ssl.crt`, and a domain without a certificate. See [Troubleshooting → The proxy serves another certificate](https://github.com/mfeuermann/meteor-deploy/blob/v0.7.0/docs/troubleshooting.md#the-proxy-serves-another-certificate).
- With your own certificate, `deploy`, `reconfig` and `proxy setup` check at the end that every proxy server serves it, for up to 30 seconds, and warn when one does not. The exit code does not change.

### Fixed

- Switching a domain from Let's Encrypt to your own certificate (`proxy.ssl.crt`) could leave nginx serving the Let's Encrypt companion's self-signed default a few seconds after the deploy: MUP's `ssl-setup.sh` copied the certificate through the companion's link in `mounted-certs`, and the companion deleted that link once the old app container was gone. The proxy steps now remove the companion's links for the app's domains before the copy, and a deploy that switches sets the certificate once more after the activation. A server that already serves the default gets the certificate back with `comet-deploy proxy setup`.

## [0.6.1] - 2026-11-17

### Added

- `deploy`, `meteor deploy` and `setup` start with a banner in a terminal: COMET in block letters, the version and the author. CI logs, pipes and files do not get it, a terminal narrower than the banner gets one line instead, and `NO_COLOR` or `TERM=dumb` turn its colors off. The README shows it too.

## [0.6.0] - 2026-11-16

The last part of phase 2: the operator commands of MUP 1.5.11 that were missing, without the parts of them that expose secrets or ports.

### Added

- **`ssh [server] [command…]`** opens a login shell on a server, or runs a command there, with the SSH settings of the config. Everything after the server name belongs to the remote command, options too (`comet-deploy ssh one docker ps -a`), as with OpenSSH. Redirected output (`> file`) stays byte for byte, and the exit code is the remote one. See [`ssh`](https://github.com/mfeuermann/meteor-deploy/blob/v0.6.0/docs/commands.md#ssh).
- **`meteor debug [server] [--port <n>]`** opens the Node.js inspector of the running app for Chrome DevTools, through SSH. The inspector stays on `127.0.0.1` at both ends: nothing is published on the server, and the local listener is on `127.0.0.1:9229`. MUP publishes it on every interface of the server. Ctrl+C removes the helper container; a second Ctrl+C quits at once. A replaced or restarted app container is detected. See [`meteor debug`](https://github.com/mfeuermann/meteor-deploy/blob/v0.6.0/docs/commands.md#meteor-debug).
- **`cache prune [--all] [--registry] [--dry-run]`** removes what deploys of this app leave on your computer: older local images (the newest build per platform stays), the build output and, with `--registry`, the local registry. Images that another checkout of an app with the same name records always stay. See [`cache prune`](https://github.com/mfeuermann/meteor-deploy/blob/v0.6.0/docs/commands.md#cache-prune).
- Hooks run for the new commands under MUP's keys: `pre.default.ssh` and `post.default.ssh`, `pre.meteor.debug` and `post.meteor.debug`, and `pre.cache.prune` and `post.cache.prune` (comet-deploy only). `api.runCommand('cache.prune')` runs `cache prune` from a method hook.

### Changed

- **`status` prints the full report, like MUP's**: after the table, one section per server with the OS, architecture, Docker version and free disk space, the container state and restart count, the `:latest` and `:previous` versions, the published ports, the **names** of the environment variables and an HTTP check from the server and from your computer. Then the MongoDB and proxy blocks. The values of the environment variables (`MONGO_URL`, `METEOR_SETTINGS`, …) never leave the server; MUP prints them. `status --overview` prints the table only, as `status` did up to 0.5.0. See [`status`](https://github.com/mfeuermann/meteor-deploy/blob/v0.6.0/docs/commands.md#status).
- `meteor status` prints the table and the server sections, without the MongoDB and proxy blocks.

## [0.5.0] - 2026-11-16

### Added

- **MUP's bundle mode.** A config without `docker.image` (MUP's default `kadirahq/meteord` image) or with `docker.prepareBundle: false` now deploys instead of being refused. MUP mounts the bundle into the base image; comet-deploy builds the version image as the base image plus one layer with the bundle, so a version is still an image and `rollback`, history and `status` work as usual. The build needs neither buildx nor emulation of the server's architecture. `--cache-from` and `--cache-to` are ignored there, with a warning. See [Bundle mode](https://github.com/mfeuermann/meteor-deploy/blob/v0.5.0/docs/configuration.md#bundle-mode).
- comet-deploy takes over servers that MUP runs in bundle mode.
- The health check waits 12 s longer for a bundle-mode container, which installs its npm dependencies each time it starts, as with MUP.

### Fixed

- The zero-downtime switch behind the proxy keeps the current container in the upstream until the old one is gone.

## [0.4.0] - 2026-11-15

### Added

- **Image transfer through MUP's private registry** (`privateDockerRegistry`, `cometDeploy.transfer: 'registry'`): comet-deploy logs in, pushes the image once, and each server pulls it and keeps it as `mup-<app>:<version>`, so `rollback`, `history` and `status` work the same. See [`privateDockerRegistry`](https://github.com/mfeuermann/meteor-deploy/blob/v0.4.0/docs/configuration.md#privatedockerregistry).
- comet-deploy takes over servers that MUP deployed with a private registry.
- `setup` and `docker setup` log the servers in to the registry when the config has `username` and `password`. comet-deploy's `start.sh` never pulls: it runs the image the server already has, while MUP's `start.sh` pulls `:latest` from the registry on every start.

## [0.3.0] - 2026-11-13

### Added

- **Hooks** under MUP's names and command keys (`hooks: { 'pre.deploy': … }`), in all three of MUP's forms: `localCommand`, `remoteCommand`, and `method` with an api object compatible with MUP's, including `api.runCommand`. `--show-hook-names` prints the hook names as MUP does. See [Hooks](https://github.com/mfeuermann/meteor-deploy/blob/v0.3.0/docs/configuration.md#hooks).
- **Image transfer over plain SSH** for servers whose `sshd` refuses TCP forwarding: the whole image goes as a compressed `docker save` archive (`cometDeploy.transfer: 'stream'`). With the default `'auto'`, preflight picks the tunnel or the stream per server.

## [0.2.0] - 2026-11-13

### Added

- **MUP's built-in MongoDB** (the `mongo` section): `setup` runs MongoDB like MUP, with MUP's scripts. The `mongo setup`, `mongo start`, `mongo stop`, `mongo logs`, `mongo shell` and `mongo status` commands. `status` shows MongoDB. See [`mongo`](https://github.com/mfeuermann/meteor-deploy/blob/v0.2.0/docs/configuration.md#mongo).
- A MongoDB version change that the data on the server cannot take is refused before anything changes (`--allow-mongo-version-change` turns the check into a warning). MUP does not check this.
- The app commands that start the app check first that MongoDB runs.

## [0.1.0] - 2026-11-12

The first release: phase 1 and the reverse proxy.

### Added

- Reads your existing `mup.js` or `mup.json` and the settings file, and has MUP 1.5.11's commands: `init`, `validate`, `setup`, `deploy`, `reconfig`, `restart`, `start`, `stop`, `logs`, `status`, `meteor destroy`, the `docker` commands and the `meteor` variants.
- Builds the Docker image **once, on your machine**, with a cached layer for the npm dependencies, for the CPU architecture of each server (`amd64`, `arm64`).
- Sends each server only the image layers it does not have yet, through a local registry and an SSH reverse tunnel, to all servers in parallel.
- Leaves the servers in MUP's layout (`start.sh` and `env.list` byte for byte as MUP writes them), so you can switch back with `mup deploy`.
- Rollout strategies (`--strategy canary|rolling|parallel`), a health check with automatic revert, a deploy lock and a deploy history on each server.
- New commands: `rollback`, `history`, `unlock`.
- MUP's reverse proxy (nginx-proxy, Let's Encrypt, load balancing): the `proxy` section and commands, and zero-downtime deploys behind it (`cometDeploy.zeroDowntime`).
- Deploying from CI with a build cache that survives between runs (`--cache-from`, `--cache-to`). See [Deploying from CI](https://github.com/mfeuermann/meteor-deploy/blob/v0.1.0/docs/ci.md).
- Secrets (`env` values, settings values, passwords) are masked in the output.

[0.7.0]: https://github.com/mfeuermann/meteor-deploy/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/mfeuermann/meteor-deploy/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/mfeuermann/meteor-deploy/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mfeuermann/meteor-deploy/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mfeuermann/meteor-deploy/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mfeuermann/meteor-deploy/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mfeuermann/meteor-deploy/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mfeuermann/meteor-deploy/releases/tag/v0.1.0
