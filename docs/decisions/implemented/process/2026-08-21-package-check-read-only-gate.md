# Decision Record: Keep the package-validation gate read-only against the working tree

Status: implemented

## Problem

The `package:check` gate validated publishable manifests by rewriting each tracked `packages/*/package.json` in place with the publishable variant (`JSON.stringify` output, not Prettier-formatted), running `bun pm pack`/publint/attw against it, and restoring the original text in a `finally`. The `ci-static` gate cluster runs up to 4 gates concurrently, so when `format:check`'s repository-wide Prettier scan sampled a manifest during that rewrite window it failed on a file that was never actually modified — the same commit passed CI on a PR run and failed after the merge push (run 32439413071, `format:check` flagging `packages/plugin/package.json`). The failure was reproduced locally by polling Prettier against the file while `package:check` ran. The SDK build step of the same gate transiently writes `packages/sdk/js/openapi.json` for the same class of reason: an unformatted generated file briefly present in the tree.

## Decision

`script/package-check.ts` no longer rewrites tracked manifests. The new `stagePackablePackage({ sourceDir, packageJson, tempDir })` copies the package directory into a temporary staging directory, writes the publishable manifest on the copy, and packs from there — mirroring how `validateSynergyWrapper` already stages the wrapper manifest in a temp directory. `validateWorkspacePackage` now reads the source manifest, computes the publishable variant, and packs the staged copy; the restore-in-`finally` around pack is gone because nothing tracked is ever touched. The module entry point is guarded by `import.meta.main` so importing it for the staging tests no longer executes the gate. For the SDK's transient generated spec, `.prettierignore` now lists `packages/sdk/js/openapi.json` (generated output; its canonical copy is `packages/sdk/openapi.json`, refreshed by `script/generate.ts`). The staging behavior is covered by `test/script/release/package-check-staging.test.ts`, which asserts the source tree stays byte-identical and the tarball carries the publishable manifest and `files`-filtered payloads.

## Alternatives considered

- **Serializing `package:check` after `format:check` via a gate dependency** — rejected: it hard-codes an ordering to paper over a gate that mutates shared state, slows the cluster, and leaves every other concurrent reader (e.g. `monorepo:check`'s sherif) exposed to the same window.
- **Making `format:check` retry on failure** — rejected: retries hide real formatting regressions and turn a deterministic gate into a probabilistic one.
- **Writing Prettier-formatted publishable manifests in place** — rejected: the race is the problem, not the formatting; a concurrent scanner can still observe a semantically wrong manifest (publish exports, resolved versions) mid-window, and publint should validate exactly what will be published.

## Consequences

- `package:check` no longer mutates the working tree, so `format:check` and every other concurrent gate observe stable file contents; the flaky red on `dev` push runs is gone.
- Packing runs from a staged copy; `bun pm pack` never includes `node_modules` in tarballs, so the staged tree (sources, `dist`, configs) mirrors the workspace package and payload selection is unchanged.
- The release publish path (`script/release/shared/publish-generic.ts`) still rewrites manifests in place by design — it runs alone in the release workflow, not in the concurrent gate cluster, so it keeps the simpler in-place flow.
- `packages/sdk/js/openapi.json` is excluded from Prettier entirely; contributors never need to format it and the transient build artifact can no longer trip the scan.
