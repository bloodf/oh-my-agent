# Cutting a release

Manual only. Nothing publishes because a tag landed on `main`. ADR-013: one verified tarball, then an explicit publish opt-in.

## Flow

1. Fill `CHANGELOG.md` Unreleased (or run **draft-changelog**).
2. Run **prepare-release** with the new semver (no `v`).
3. Merge the `release/vX.Y.Z` PR.
4. Tag `main`: `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. Run **release** with tag `vX.Y.Z` and publish **unchecked**. Read the draft GitHub Release.
6. Re-run **release** with the same tag and publish **checked**. Approve the `npm-publish` environment if it asks.

About 20 minutes of operator time plus the suite.

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push/PR to `main` | Gates. Does not publish. |
| `draft-changelog.yml` | manual | Drafts Unreleased from commits since the last tag. Unchecked = summary only. |
| `prepare-release.yml` | manual | Bumps `package.json` + `omp.version`, cuts Unreleased, opens a PR. |
| `release.yml` | manual | Verifies the tag, packs once, consumer-install smoke, GitHub Release, optional npm publish of that tarball. |

E2E (`tests/consumer-install.test.ts`, console client) stays on the manual **release** workflow, not on every push.

## GitHub settings to add

Do these once. About 10 minutes.

### Must

1. **Actions → General → Workflow permissions**
   - Read and write permissions (so prepare-release can push a branch and `release` can create a GitHub Release).
   - Check **Allow GitHub Actions to create and approve pull requests**.

2. **Settings → Environments → New environment: `npm-publish`**
   - Required reviewers: you.
   - Deployment branches: `main` only, or leave unrestricted because this job checks out a tag, not a branch.
   - The **publish** job refuses to run until you approve it in the Actions UI.

3. **Secret `NPM_TOKEN`**
   - npmjs.com → Access Tokens → Granular Access Token.
   - Read and write on `@bloodf/oh-my-agent`.
   - Repo → Settings → Secrets and variables → Actions → New repository secret named `NPM_TOKEN`.
   - The publish step is `npm publish <tarball> --provenance`. Provenance also needs **id-token: write** (already in the workflow).

### Should

4. **npm Trusted Publishing** (optional, stronger than a long-lived token)
   - npmjs.com → package `@bloodf/oh-my-agent` → Trusted Publisher.
   - GitHub Actions, repo `bloodf/oh-my-agent`, workflow `release.yml`, environment `npm-publish`.
   - After that works, you can delete `NPM_TOKEN`. Keep the secret until you have seen one successful OIDC publish.

5. **Branch protection on `main`**
   - Require the `ci` check.
   - Do not allow tag-push to skip reviews for the release PR.

6. **Actions → General**
   - Allow GitHub Actions to create releases (covered by contents write).
   - Restrict workflows to the default `GITHUB_TOKEN`; do not add a personal PAT unless a fork PR needs it. These workflows are `workflow_dispatch` only.

### Do not

- Do not add a `on: push: tags:` publisher. That would publish without an operator click.
- Do not put npm tokens in environment variables on your laptop for this ritual.
- Do not unpublish a bad version. `npm deprecate` and a forward patch, per `CHANGELOG.md`.

## Local commands (same as CI)

```sh
bun scripts/cut-changelog.ts draft-commits   # stdin: git log subjects
bun scripts/cut-changelog.ts cut --version 1.0.2 --date 2026-09-05
bun scripts/cut-changelog.ts notes --version 1.0.2
bun scripts/cut-changelog.ts bump-manifest --version 1.0.2
```
