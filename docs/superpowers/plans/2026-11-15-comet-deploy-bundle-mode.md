# Bundle Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** comet-deploy deploys MUP configs in bundle mode (default `kadirahq/meteord`, `docker.prepareBundle: false`) without changes, and alternates with MUP on the same servers.

**Architecture:** In bundle mode the version image `mup-<app>:<version>` is the base image plus one layer, `/bundle/bundle.tar.gz`, made with `docker create` + `docker cp -` + `docker commit` (no Dockerfile, no buildx, ONBUILD never runs). Everything after the build (distribution, retag, rollback, history) stays as it is. A server MUP last deployed in bundle mode is taken over at the start of every activation and restart: its bundle becomes an image tagged `:latest` and `:mup-bundle`.

**Tech Stack:** TypeScript (Node ≥ 20), vitest, node-tar (`tar` ^7.4.3, new dependency), bash templates (EJS) run over SSH, Docker CLI.

**Spec:** `docs/superpowers/specs/2026-11-15-comet-deploy-bundle-mode-design.md`

## Global Constraints

- Bundle mode is exactly `!prepareBundleSupported(app.docker)` (src/build/index.ts). Nothing else turns it on.
- Prepare-mode configs must not change: no new hash keys, no new output, same scripts, apart from the zd-start/zd-finish change (§4.4) and the takeover script that finds nothing on their servers.
- Image layer: `/bundle/` root:root 0755, `/bundle/bundle.tar.gz` root:root 0644, nothing else; even when the base image has its own `/bundle`.
- Labels on a bundle image: `comet-deploy.version=<version>` and `comet-deploy.bundle=1`. Adopted MUP images carry `comet-deploy.bundle=1`.
- `bundle.tar.gz`: node-tar `c({ file, cwd: buildLocation, portable: true, gzip: { level: 9 } }, ['bundle'])`, written to `<buildLocation>/bundle.tar.gz`.
- `BUNDLE_IMAGE_VERSION = 1`; `hashExtras` adds `mode: 'bundle'` and `bundleImage: BUNDLE_IMAGE_VERSION` only in bundle mode.
- Health check extra: `+12` seconds when the checked container has label `comet-deploy.bundle=1`.
- Exact texts (copy verbatim; `<…>` are values):
  - create failure: `The docker image "<image>" is not available for <platform>: <stderr of docker create, trimmed>`, hint `In bundle mode the servers run this image itself. Use an image that exists for <platform>, or a zodern/meteor image.`
  - info: `bundle mode: <localTag> is "<image>" with the bundle in /bundle; the app installs its npm dependencies each time the container starts.`
  - warning: `--cache-from and --cache-to are ignored in bundle mode: the app image is not built with BuildKit.`
  - validate warning, path `<appKey>.docker.buildInstructions`, message `are ignored in bundle mode, as in MUP: the base image "<image>" runs the bundle as it is. Set docker.prepareBundle: true (or use a zodern/meteor image) to apply them.`
  - validate warning, path `<appKey>.docker.image`, message `"<image>" cannot unpack the bundle in bundle mode: its app user cannot write to /bundle, with MUP as with comet-deploy. Use "zodern/meteor:root", or remove docker.prepareBundle: false.`
  - verbose line after a takeover: `took over the bundle MUP runs as :latest`.
- Public docs and commits never name private servers, apps or IPs.
- Commits on `feat/bundle-mode`, no AI attribution lines.
- Heavy runs (full `npm test`, typecheck, build, integration) only at the end; per task run the task's unit files and lint.

## Review Focus

1. **The base image already has `/bundle`** (`zodern/meteor:root` has it as app:app 700): the result must still be root:root 755. Test: Task 1 local-Docker integration, base image with `RUN mkdir -m 700 /bundle && chown 1:1 /bundle`.
2. **A prepare-mode server and a prepare-mode config never see the takeover:** a container without a `/bundle` mount, or with one whose source is not `/opt/<app>/current`, or `current/bundle.tar.gz` missing → script prints nothing and changes nothing. Test: Task 5 script tests "no mount", "foreign mount source", "no bundle.tar.gz".
3. **Takeover fails half-way** (commit fails): temp container and work dir are removed, `:latest` is unchanged, the command fails with the script's stderr. Test: Task 5 script test "commit fails".
4. **Zero-downtime switch fails** (health check of the next container fails): `current` stays, so the old MUP container keeps its files. Test: Task 6 `zd-finish.sh` order test plus `zd-start.sh` no longer removing `current`.
5. **Multi-platform build in bundle mode** (amd64 + arm64 servers): one bundle image per platform, each `docker create --platform <p>`, local tags `…-amd64` / `…-arm64`, separate build locations. Test: Task 2 "builds one image per platform".

---

### Task 1: Bundle image primitives

**Files:**
- Create: `src/build/bundle-image.ts`
- Modify: `src/local/exec.ts` (`RunOptions.input?: string | Buffer`), `package.json` (`"tar": "^7.4.3"` in `dependencies`)
- Test: `test/unit/build/bundle-image.test.ts`, `test/integration/bundle-image.test.ts`

**Interfaces:**
- Produces:
  - `BUNDLE_IMAGE_VERSION = 1` (exported const)
  - `writeBundleArchive(buildLocation: string): Promise<string>`: returns `<buildLocation>/bundle.tar.gz`.
  - `bundleLayerTar(archive: Buffer): Buffer`: uncompressed tar, exactly two entries, `bundle/` (dir, 0o755, uid/gid 0) then `bundle/bundle.tar.gz` (file, 0o644, uid/gid 0), with end-of-archive blocks.
  - `type RunFn = typeof run` (from src/local/exec.ts).
  - `createBundleImage(o: { baseImage: string; platform: Platform; archivePath: string; tag: string; labels: Record<string, string>; run?: RunFn }): Promise<{ imageId: string }>`: `docker create --platform <p> <base>` → `docker cp - <cid>:/` with `bundleLayerTar(readFile(archivePath))` as stdin → `docker commit --change 'LABEL k=v'… <cid> <tag>` → `docker image inspect --format {{.Id}} <tag>`; `docker rm -f <cid>` in `finally`. A failed create throws the exact create-failure CometError (Global Constraints); a failed cp/commit throws `CometError('Creating the bundle image <tag> failed: <stderr>')`.

- [ ] **Step 1: Write the failing unit tests** in `test/unit/build/bundle-image.test.ts`:
  - `writeBundleArchive packs bundle/ as gzip with every entry under bundle/`: temp dir with `bundle/main.js`, `bundle/programs/server/x.js`; result path ends with `/bundle.tar.gz`; first two bytes `0x1f 0x8b`; `tar.t({ file, onReadEntry })` paths all start with `bundle/`.
  - `bundleLayerTar has exactly the two entries of spec §4.2`: parse with node-tar `Parser` (or `t` on a stream); entries `[{ path: 'bundle/', type: 'Directory', mode: 0o755, uid: 0, gid: 0 }, { path: 'bundle/bundle.tar.gz', type: 'File', mode: 0o644, uid: 0, gid: 0, size: archive.length }]`, and the file content equals the archive bytes.
  - `createBundleImage runs create, cp, commit and removes the container`: fake `run` records `[cmd, args, input]`; create → stdout `cid123\n`; assert calls in order: `docker create --platform linux/amd64 kadirahq/meteord`, `docker cp - cid123:/` with a Buffer input, `docker commit --change 'LABEL comet-deploy.version=v1' --change 'LABEL comet-deploy.bundle=1' cid123 mup-a:v1` (each `--change` and its value as separate args: `['--change', 'LABEL comet-deploy.version=v1']`), image inspect, `docker rm -f cid123`; returns the inspected id.
  - `createBundleImage removes the container when commit fails`: commit → code 1, stderr `no space`; rejects with `/Creating the bundle image mup-a:v1 failed: no space/`; last call is `rm -f cid123`.
  - `createBundleImage reports a base image missing for the platform`: create → code 1, stderr `no matching manifest for linux/arm64`; rejects with message exactly `The docker image "kadirahq/meteord" is not available for linux/arm64: no matching manifest for linux/arm64` and hint `In bundle mode the servers run this image itself. Use an image that exists for linux/arm64, or a zodern/meteor image.`; no `rm` call (nothing was created).

- [ ] **Step 2: Run** `npx vitest run test/unit/build/bundle-image.test.ts`. Expected: FAIL, module `src/build/bundle-image.ts` not found.

- [ ] **Step 3: Implement.** `npm install tar@^7.4.3`; widen `RunOptions.input` to `string | Buffer` (`child.stdin.end(o.input ?? '')` already accepts both). Write `bundleLayerTar` with node-tar's `Header` class (`new Header({ path, mode, uid: 0, gid: 0, uname: 'root', gname: 'root', size, mtime, type })`, `encode()` into 512-byte blocks, file data padded to 512, then two zero blocks); no shelling out to the system tar.

- [ ] **Step 4: Run** the unit file again. Expected: PASS (5 tests).

- [ ] **Step 5: Write the local-Docker integration test** `test/integration/bundle-image.test.ts` (no network): build a base image `comet-test-bundle-base:<pid>` from `debian:bookworm` (already local through the fake-server harness) with
  ```dockerfile
  FROM debian:bookworm
  RUN mkdir -m 700 /bundle && chown 1:1 /bundle
  ONBUILD RUN exit 1
  ENTRYPOINT ["sh", "-c", "stat -c '%u:%g %a %n' /bundle /bundle/bundle.tar.gz"]
  ```
  then `createBundleImage` with the native platform (`linux/arm64` on arm64 hosts, else `linux/amd64`) and an archive from `writeBundleArchive`. Assertions: `docker run --rm <tag>` prints exactly `0:0 755 /bundle` and `0:0 644 /bundle/bundle.tar.gz`; `docker image inspect` shows both labels and the ENTRYPOINT; the bundle file inside equals the archive (`docker run --rm --entrypoint sha256sum <tag> /bundle/bundle.tar.gz` vs local sha256); `docker ps -a --filter ancestor=<base>` lists no leftover container. `afterAll` removes both images.

- [ ] **Step 6: Run** `npx vitest run -c vitest.integration.config.ts test/integration/bundle-image.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit** `feat(build): bundle image from base image, docker cp and commit`.

### Task 2: buildApp bundle-mode branch

**Files:**
- Modify: `src/build/index.ts` (`buildApp`, `hashExtras`, `prepareBundleSupported` doc comment)
- Create: `test/helpers/fake-docker.ts`
- Test: `test/unit/build/build-app.test.ts` (replace the "refuses … phase 2" test)

**Interfaces:**
- Consumes: Task 1 `writeBundleArchive`, `createBundleImage`, `BUNDLE_IMAGE_VERSION`.
- Produces: `buildApp` returns `BuiltImage[]` in bundle mode too, with `depsHash: ''` and `nodeVersion` = `readNodeVersion(bundleDir)` or `''` when that throws. `test/helpers/fake-docker.ts`: `fakeDocker(script: string): { log: string; restore(): void }`, which writes an executable `docker` (bash) into a temp dir, prepends it to `process.env.PATH`, sets `FAKE_DOCKER_LOG`, and returns the log path; `restore()` puts PATH back.

- [ ] **Step 1: Write the failing tests** in `build-app.test.ts` (`describe('buildApp in bundle mode')`), using a fake meteor (`buildOptions.executable`, writes `$3/bundle/main.js` and, per test, `$3/bundle/star.json`) and `fakeDocker` (answers `image inspect` → `sha256:img`, `create` → `cid1`, `cp`/`commit`/`rm`/`pull` → 0, `buildx` → exit 99 and log it), with a captured reporter:
  - `builds the image with create, cp and commit, never buildx`: kadirahq config, `platforms: ['linux/amd64']`; log contains `create --platform linux/amd64 kadirahq/meteord`, `cp - cid1:/`, `commit --change LABEL comet-deploy.version=<v> --change LABEL comet-deploy.bundle=1 cid1 mup-myapp:<v>`, `rm -f cid1`; no `buildx`; result `[{ platform: 'linux/amd64', localTag: 'mup-myapp:<v>', imageId: 'sha256:img', depsHash: '', fromCache: false, … }]`; `<buildLocation>/bundle.tar.gz` exists.
  - `prints the bundle-mode info line`: output contains `bundle mode: mup-myapp:<v> is "kadirahq/meteord" with the bundle in /bundle; the app installs its npm dependencies each time the container starts.`
  - `warns that --cache-from and --cache-to are ignored`: with `cacheFrom: ['type=local,src=/c']` → the exact warning once; without → no warning.
  - `does not need a Node version`: no star.json → resolves, `nodeVersion: ''`.
  - `ignores buildInstructions`: `buildInstructions: ['RUN echo $API_HOST']`, env `API_HOST` → no `build args are visible` warning, no buildx call.
  - `builds one image per platform`: `platforms: ['linux/amd64', 'linux/arm64']` → two creates with the two platforms, tags `mup-myapp:<v>-amd64` / `-arm64`, build locations `<loc>-amd64` / `<loc>-arm64`.
  - `reuses an unchanged build`: second `buildApp` with a new version → output `No changes since <v1>: reusing mup-myapp:<v1>`, no second `create`.
- In `describe('hashExtras')` add:
  - `adds the mode only in bundle mode`: kadirahq app → `mode: 'bundle'`, `bundleImage: 1`; `zodern/meteor:root` app → no `mode` and no `bundleImage` key (prepare-mode hashes stay as they were).

- [ ] **Step 2: Run** `npx vitest run test/unit/build/build-app.test.ts`. Expected: FAIL (bundle mode still throws "phase 2"; `mode` missing).

- [ ] **Step 3: Implement.** In `buildApp`, drop the throw; compute `const bundleMode = !prepareBundleSupported(app.docker)` once; before the platform loop, in bundle mode, warn once when `o.cacheFrom?.length || o.cacheTo?.length`. In the loop, after the cache checks, `pullImage` and `meteor build` as today, then in bundle mode: info line, `writeBundleArchive(buildLocation)`, `createBundleImage({ baseImage, platform, archivePath, tag: localTag, labels: { 'comet-deploy.version': o.version, 'comet-deploy.bundle': '1' } })` inside `r.phase(\`bundle image (${platform})\`, …)`, and the same cache entry as prepare mode with `depsHash: ''`. The prepare-mode path stays byte-for-byte as it is.

- [ ] **Step 4: Run** the file. Expected: PASS.

- [ ] **Step 5: Commit** `feat(build): build bundle-mode images instead of refusing them`.

### Task 3: Validate warnings and preflight

**Files:**
- Modify: `src/config/validate.ts` (app block, after the `prepareBundleLocally`/`useBuildKit` loop), `src/deploy/preflight.ts`
- Test: `test/unit/config/validate.test.ts`, `test/unit/deploy/preflight.test.ts`

**Interfaces:**
- Consumes: `prepareBundleSupported` (src/build/index.ts).
- Produces: `PreflightInput.bundleMode?: boolean`; `runPreflight` sets it from the config and skips `buildxPlatforms()` when true.

- [ ] **Step 1: Write the failing tests.**
  - validate, `describe('bundle mode')`:
    - `warns that buildInstructions are ignored`: `docker: { image: 'kadirahq/meteord', buildInstructions: ['RUN x'] }` → warning at `app.docker.buildInstructions` with the exact message; `hasFatal` false.
    - `warns about a non-root zodern/meteor image`: `zodern/meteor`, `zodern/meteor:latest`, `zodern/meteor:slim` each with `prepareBundle: false` → warning at `app.docker.image`, message starts `"zodern/meteor…" cannot unpack the bundle in bundle mode` (exact text for `zodern/meteor:latest`).
    - `accepts root zodern/meteor images in bundle mode`: `zodern/meteor:root`, `zodern/meteor:1.2.3-root` with `prepareBundle: false` → no warning at `app.docker.image`.
    - `stays quiet in prepare mode`: `zodern/meteor:latest` without `prepareBundle`, with buildInstructions → neither warning.
    - `no longer refuses bundle mode`: kadirahq config → no error issue.
  - preflight:
    - `skips the buildx checks in bundle mode`: `local.platforms: []` and `bundleMode: true` → no buildx error; with `platforms: ['linux/amd64']`, server arm64, `bundleMode: true` → no emulation error; Docker down still errors.

- [ ] **Step 2: Run** `npx vitest run test/unit/config/validate.test.ts test/unit/deploy/preflight.test.ts`. Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement.** Root tag check: the warning fires when the image starts with `zodern/meteor` and its tag (after the last `:`, empty when there is none) does not contain `root`. In `evaluatePreflight` guard both buildx branches with `!i.bundleMode`; in `runPreflight` call `buildxPlatforms()` only when not in bundle mode (pass `[]` otherwise).

- [ ] **Step 4: Run** both files. Expected: PASS.

- [ ] **Step 5: Commit** `feat(config): bundle-mode warnings; preflight skips buildx in bundle mode`.

### Task 4: Health check waits 12 s longer for bundle images

**Files:**
- Modify: `templates/comet/health-check.sh`
- Test: `test/unit/deploy/health-check.test.ts`

**Interfaces:**
- Produces: no TypeScript change. After `END=$((START + TIMEOUT))` the script reads `sudo docker inspect -f '{{index .Config.Labels "comet-deploy.bundle"}}' "$CONTAINER"` and adds `BUNDLE_EXTRA=12` to `END` when the value is `1`.

- [ ] **Step 1: Write the failing test** `adds 12 s for a container with the comet-deploy.bundle label`: run the rendered script in local bash with fake `sudo` (pass-through), fake `docker` (label → `$LABEL`, state → `running`, network → `bridge`, IP → `10.0.0.1`), fake `curl` (prints `000`) and fake `date` (prints a counter from a state file that advances by 5 each call), `timeoutSec: 10`. With `LABEL=1` the result line is `COMET_HEALTH fail timeout - <s>` with `s ≥ 22`; with `LABEL=` it is `< 22` and `≥ 10`. Follow the fake-binary pattern of `test/unit/remote/retag-script.test.ts`.

- [ ] **Step 2: Run** `npx vitest run test/unit/deploy/health-check.test.ts`. Expected: FAIL (both runs end before 22).

- [ ] **Step 3: Implement** the two lines in the template, with a comment pointing to spec §4.4 (MUP's start.sh waits 15 s with the volume, 3 s with an image).

- [ ] **Step 4: Run** the file. Expected: PASS.

- [ ] **Step 5: Commit** `feat(deploy): health check waits 12 s longer for bundle images`.

### Task 5: Taking over a MUP bundle-mode server

**Files:**
- Create: `templates/comet/bundle-adopt.sh`
- Modify: `src/remote/ops.ts` (`adoptMupBundle`), `src/deploy/activate.ts` (call before the snapshot, every mode), `src/deploy/pipeline.ts` (`PipelineDeps.adoptMupBundle`, call in `restartPipeline` before stop / start), `templates/comet/destroy-extra.sh` (`:mup-bundle`)
- Test: `test/unit/remote/bundle-adopt-script.test.ts` (new), `test/unit/remote/ops.test.ts`, `test/unit/deploy/activate.test.ts`, `test/unit/deploy/lifecycle.test.ts`, `test/unit/deploy/zero-downtime.test.ts` (fake labels)

**Interfaces:**
- Consumes: `appDir`, `containerName`, `localImageRepo` (src/core/naming.ts).
- Produces: `adoptMupBundle(conn: SshConnection, o: { appName: string; container: string; repo: string }): Promise<boolean>` (true when the script printed `adopted`), script title `Taking over the bundle MUP runs`. `PipelineDeps.adoptMupBundle: typeof adoptMupBundle`. The script's first line is `# bundle-adopt.sh: …` (test fakes label scripts by it, checked before the registry `echo "adopted"` label).

- [ ] **Step 1: Write the failing script tests** in `bundle-adopt-script.test.ts`, rendered with `cometScript('bundle-adopt.sh', …)`, run in local bash with fake `sudo` (pass-through), fake `docker` (state file of tags → ids, mounts and image of the container from env vars, logs every call) and a real temp dir as `APP_DIR` (the template takes `appDir` so the test can point it at a temp dir):
  - `takes over a container that runs the bundle from current`: mount `<appDir>/current → /bundle`, `current/bundle.tar.gz` present, container image `sha256:base` → calls `create sha256:base`, `cp - <tmp>:/`, `commit --change LABEL comet-deploy.bundle=1 <tmp> <repo>:latest`, `tag <repo>:latest <repo>:mup-bundle`, `rm -f <tmp>`; stdout `adopted`; the tar stream given to `cp` lists `bundle/` and `bundle/bundle.tar.gz` (fake docker saves stdin; test lists it with node-tar).
  - `removes the image the old :mup-bundle tag pointed to`: state has `<repo>:mup-bundle sha256:old` → after the new tag, `rmi sha256:old` (no `-f`); a failing `rmi` does not fail the script.
  - `does nothing without a /bundle mount` (Review Focus 2): no mounts → no `create`, empty stdout, exit 0.
  - `does nothing for a mount from elsewhere` (Review Focus 2): `/srv/x → /bundle` → nothing.
  - `does nothing without current/bundle.tar.gz` (Review Focus 2).
  - `does nothing without a container`: `inspect` fails → nothing, exit 0.
  - `cleans up when commit fails` (Review Focus 3): commit exits 1 → script exit ≠ 0, `rm -f <tmp>` called, work dir `<appDir>/tmp/comet-bundle-adopt` gone, `:latest` untouched.
- In `ops.test.ts`: `listVersions ignores :mup-bundle` (versions.sh output with `mup-bundle sha256:x` → not in `versions`); `destroy-extra.sh removes :mup-bundle` (rendered text contains `rmi --force "$REPO:mup-bundle"`).
- In `activate.test.ts`: label `# bundle-adopt.sh` as `bundle-adopt`; `takes over a MUP bundle before the snapshot in deploy, reconfig and rollback`: the call list has `bundle-adopt` before `snapshot` (deploy, reconfig) and before `retag-swap` / `retag-activate` (rollback); when the fake answers `adopted`, the verbose output has `took over the bundle MUP runs as :latest`. Update the existing exact call lists with the new entry.
- In `lifecycle.test.ts` (restart): `restart takes over a MUP bundle before stopping the app` (fake `adoptMupBundle` in deps records the order: adopt before stop script, and before `startServer` with the zero-downtime switch).

- [ ] **Step 2: Run** `npx vitest run test/unit/remote test/unit/deploy/activate.test.ts test/unit/deploy/lifecycle.test.ts`. Expected: FAIL on the new tests (template and function missing).

- [ ] **Step 3: Implement the template.** Variables `appDir`, `container`, `repo`. Order: read the container's `/bundle` mount source with `docker inspect -f '{{range .Mounts}}{{if eq .Destination "/bundle"}}{{.Source}}{{end}}{{end}}'` (exit 0 with no output when the container is missing or the source is not `$APP_DIR/current`); require `$APP_DIR/current/bundle.tar.gz`; `IMAGE_ID` from `{{.Image}}`; `set -e`; work dir `$APP_DIR/tmp/comet-bundle-adopt` made with `sudo mkdir -p …/bundle`, `sudo cp` the tarball, `sudo chown -R 0:0`, `sudo chmod 755` / `644`; `trap` removes the temp container and the work dir on every exit; `OLD=$(docker image inspect -f '{{.Id}}' "$REPO:mup-bundle" 2>/dev/null || true)`; create, `sudo tar -C "$WORK" --numeric-owner -cf - bundle | sudo docker cp - "$TMP:/"`, commit to `:latest`, tag `:mup-bundle`; `[ -n "$OLD" ] && [ "$OLD" != "$NEW" ] && sudo docker rmi "$OLD" >/dev/null 2>&1 || true`; `echo adopted`.

- [ ] **Step 4: Implement the wiring.** `adoptMupBundle` next to `adoptMupRegistryImage`. In `activateServer`, right after the registry takeover and before the snapshot, for every mode: `if (await adoptMupBundle(conn, { appName: app.name, container: containerName(config), repo: localImageRepo(config) })) r.verboseLine(server, 'took over the bundle MUP runs as :latest');`. In `restartPipeline`, after `const conn = …` and before the mode branch, the same call through `d.adoptMupBundle`. Add `sudo docker rmi --force "$REPO:mup-bundle" >/dev/null 2>&1 || true` to `destroy-extra.sh` with a one-line comment.

- [ ] **Step 5: Run** the Step 2 command, then `npx vitest run test/unit/deploy`. Expected: PASS.

- [ ] **Step 6: Commit** `feat(deploy): take over servers MUP runs in bundle mode`.

### Task 6: Zero-downtime switch removes `current` only at the end

**Files:**
- Modify: `templates/comet/zd-start.sh` (drop `sudo rm -rf current || true`), `templates/comet/zd-finish.sh` (new var `appDir`; removal after `docker rename`), `src/deploy/zero-downtime.ts` (pass `appDir: appDir(c)` to zd-finish.sh)
- Test: `test/unit/deploy/zero-downtime.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: zd-finish.sh, after `sudo docker rename "$NEXT" "$NAME"` and before `unroute`: when `docker inspect -f '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$NAME"` succeeds and does not list `$APP_DIR/current`, `sudo rm -rf "$APP_DIR/current"`.

- [ ] **Step 1: Write the failing tests:**
  - `zd-start no longer removes current` (Review Focus 4): rendered zd-start.sh has no `rm -rf current`; it still removes `last` when `:previous` exists.
  - `zd-finish removes current after the old container is gone and only if the new one does not mount it`: in the rendered zd-finish.sh the index of `rm -rf "$APP_DIR/current"` is after `docker rename` and after `docker rm -f "$NAME"`; the removal sits inside an `if` on the mount list containing `"$APP_DIR/current"`; `APP_DIR='/opt/myapp'` is set.
  - `a failed switch keeps current` (Review Focus 4): the existing test where the next container's health check fails asserts `zd-finish` is never called; extend it to assert no command containing `rm -rf` and `current` ran.

- [ ] **Step 2: Run** `npx vitest run test/unit/deploy/zero-downtime.test.ts`. Expected: FAIL on the first two.

- [ ] **Step 3: Implement** the template changes and the `appDir` variable, with the reason in the comments (MUP's old container serves from `current` until it is removed).

- [ ] **Step 4: Run** the file. Expected: PASS.

- [ ] **Step 5: Commit** `fix(deploy): zero-downtime switch keeps current until the old container is gone`.

### Task 7: MUP bundle-mode interop on fake servers

**Files:**
- Create: `test/integration/bundle.test.ts`

**Interfaces:**
- Consumes: `sampleProject`, `writeTestConfig({ docker: { image: 'zodern/meteor:root', prepareBundle: false } })`, `cli`, `mup`, `curlApp`, `imageId`, `containerId` from `test/integration/helpers.ts`; `startFakeServers` from the harness; an app change per step (rewrite `server/main.js`'s answer to `v1` … `v6`, as `interop.test.ts` does). `deployCheckWaitTime: 300`.

- [ ] **Step 1: Write the scenario** (one `describe`, steps as sequential `it`s on one fake server, like `interop.test.ts`), per spec §6:
  1. `mup setup`, `mup deploy` → `curlApp` answers `v1`; `docker inspect` of the app container lists a mount with destination `/bundle`.
  2. `v2`, `comet-deploy deploy` → answers `v2`; no `/bundle` mount; `imageId(':previous')` = `imageId(':mup-bundle')`; that image has label `comet-deploy.bundle=1`.
  3. `comet-deploy rollback` → answers `v1`; no mount.
  4. `v4`, `mup deploy` → answers `v4`; mount `/bundle` again.
  5. `v5`, `comet-deploy deploy` → `:previous` image = `:mup-bundle` image (the v4 takeover); then `mup reconfig` → answers `v5`.
  6. `v6`, `mup deploy`, then `comet-deploy restart` → answers `v6`; no mount; `docker images -q -f dangling=true -f label=comet-deploy.bundle=1` is empty.

- [ ] **Step 2: Run** `caffeinate -i npx vitest run -c vitest.integration.config.ts test/integration/bundle.test.ts > <workspace>/bundle-integ.log 2>&1`, read the tail. Expected: PASS. A failure here is a finding against Tasks 1–6: debug it with superpowers:systematic-debugging; do not loosen the assertions.

- [ ] **Step 3: Commit** `test(integration): alternate with MUP in bundle mode`.

### Task 8: Documentation

**Files:**
- Modify: `docs/configuration.md`, `docs/how-it-works.md`, `docs/migrating-from-mup.md`, `docs/troubleshooting.md`, `docs/commands.md`, `README.md`, the `prepareBundleSupported` comment in `src/build/index.ts` if Task 2 left it.

**Interfaces:** none.

- [ ] **Step 1: Write the docs** per spec §7: configuration.md drops "Planned for phase 2" and gains a "Bundle mode" section (when it happens; the image = base image + `/bundle/bundle.tar.gz`; slower start; +12 s health check; `buildInstructions` ignored; `zodern/meteor:root`; prepare mode recommended); how-it-works.md covers the bundle build, the takeover (`:mup-bundle`) and when zero-downtime removes `current`; migrating-from-mup.md drops bundle mode from "Check first", adds it to "What changes" and the differences table, plus side-by-side notes; troubleshooting.md gets the three entries (base image missing for a platform, non-root zodern/meteor, health check timing out during the npm install) and the "Not supported yet (phase 2)" list shrinks; README status, limits, roadmap and the "Do I have to change my mup.js?" answer; commands.md: the deploy build without buildx in bundle mode.

- [ ] **Step 2: Check** `grep -rn "phase 2" docs README.md | grep -i bundle` → no lines; `grep -rn "cannot build an app image" src docs README.md` → no lines.

- [ ] **Step 3: Commit** `docs: bundle mode`.

---

## Final verification (after Task 8)

Run once, each into the workspace with the tail read: `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, then every integration file with `caffeinate -i bash <scratchpad>/run-integ-list.sh <outdir> <files…>`. Expected: all green; the existing integration files pass unchanged.
