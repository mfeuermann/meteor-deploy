# Releasing

comet-deploy is published to npm as [`comet-deploy`](https://www.npmjs.com/package/comet-deploy). A release is a version tag: pushing `v1.2.3` runs the [Release workflow](../.github/workflows/release.yml), which checks the code, publishes that version and makes its [GitHub release](https://github.com/mfeuermann/meteor-deploy/releases) from [CHANGELOG.md](../CHANGELOG.md).

## A release

1. Make sure `main` is green in the [CI workflow](../.github/workflows/ci.yml), including the integration job.
2. Write the release notes: a section `## [1.2.3] - <date>` at the top of [CHANGELOG.md](../CHANGELOG.md), with what a user of the previous version notices (`Added`, `Changed`, `Fixed`, `Removed`), and the compare link at the end of the file (`[1.2.3]: https://github.com/mfeuermann/meteor-deploy/compare/v1.2.2...v1.2.3`). Bump the version in the docs too (`grep -rn 1.2.2 README.md docs`). Commit them.

   `node scripts/release-notes.ts 1.2.3` prints the notes as the GitHub release will show them. Without a section for the version in `package.json`, a unit test fails, and so does the Release workflow before it publishes.
3. Bump the version. `npm version` changes `package.json` and `package-lock.json`, commits, and creates the tag:

   ```bash
   npm version minor      # or patch, major, or an exact version such as 0.3.0-beta.1
   git push --follow-tags
   ```

4. The Release workflow:
   - fails when the tag is not `v` followed by the version in `package.json`, or when CHANGELOG.md has no notes for it;
   - packs the package, installs it and runs the installed command (`npm run test:package`);
   - runs `npm publish`, which first runs lint, typecheck and the unit tests (`prepublishOnly`) and builds `dist/` (`prepack`). A version that is already on npm is skipped, so a re-run does no harm;
   - creates the GitHub release `v1.2.3` with the version's section of CHANGELOG.md as its notes (a re-run updates them). To fix the notes later, change CHANGELOG.md on `main` and run `gh release edit v1.2.3 --notes-file <(node scripts/release-notes.ts 1.2.3)`.

   A version with a prerelease part (`0.3.0-beta.1`) is published under the `next` dist-tag, so `npm install -g comet-deploy` keeps installing the last stable version, and its GitHub release is marked as a prerelease.

The integration tests do not run in the Release workflow: they take about an hour and depend on Docker Hub. Step 1 is where they count.

The version is also part of comet-deploy's build cache key and is recorded in each server's deploy history and lock, so every published change needs a new version.

## How the workflow logs in to npm

The workflow is an npm [trusted publisher](https://docs.npmjs.com/trusted-publishers): npm accepts a publish from this repository's `release.yml` through OpenID Connect, without an npm token. npm also adds a provenance statement that links each version to the workflow run that built it.

The trusted publisher settings on npmjs.com (package `comet-deploy` → Settings → Trusted publishing):

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `mfeuermann` |
| Repository | `meteor-deploy` |
| Workflow filename | `release.yml` |
| Environment | empty |

These values must match exactly. If the repository or the workflow file is renamed, update them, and keep `repository.url` in `package.json` pointing at the repository. A mismatch shows up as `E404 Not Found` in the publish step.

With the trusted publisher in place, set Publishing access to "Require two-factor authentication and disallow tokens". The workflow still publishes; tokens no longer can.

## The first publish

npm configures trusted publishing per package, so the package must exist before the workflow can publish it. The first version is published by hand, by the owner of the npm account:

```bash
npm login
git checkout main && git pull
npm publish                                # runs the checks and the build first
git tag v0.1.0 && git push origin v0.1.0   # the workflow sees the version on npm and skips it
```

Then add the trusted publisher as above. From the next version on, releases go through the workflow.
