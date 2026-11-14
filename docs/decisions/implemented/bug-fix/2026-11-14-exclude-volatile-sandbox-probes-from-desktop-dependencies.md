# Decision Record: Exclude volatile sandbox probes from Desktop dependencies

Status: implemented

## Problem

Desktop dependency packaging traversed a linked Local Runtime workspace while sandbox acceptance removed its temporary probe Home. The dependency inventory included that volatile subtree, so copying could fail after discovery or include test-only files in the application. Positive application file patterns and the dependency's package file list did not constrain this traversal.

## Decision

The Desktop `electron-builder` file matcher excludes only the Local Runtime `sandbox-probes` subtree before its dependency walker descends into it. Official PTY and watcher artifacts, sandbox assets and the independent native package remain selected by their existing owners. The pinned `app-builder-lib` 26.17.0 dependency matcher and copy helper define this selection boundary; the regression executes those actual implementations and the ASAR packer.

Provenance: [app-builder-lib 26.17.0](https://registry.npmjs.org/app-builder-lib/26.17.0), `fileMatcher` and `NodeModuleCopyHelper` in the published package.

Local adaptation: apply the exact probe exclusion in the [Desktop matcher](../../../../apps/desktop/electron-builder.json) and verify its actual dependency copy through ASAR while retaining native payload selection.

## Alternatives considered

**Change the dependency package's file list.** The Desktop dependency walker consumes negative application patterns and recursively visits the linked directory. The package list does not control this copy operation.

**Exclude all build artifacts.** PTY and watcher builders also publish official assets and provenance receipts there. Removing that directory would damage the native closure.

**Delay probe cleanup or ignore missing copies.** Both leave volatile test data eligible for the application and make assembly depend on unrelated fixture timing.

## Consequences

Desktop assembly keeps the original dependency and native payload owners while excluding temporary acceptance state. The real selection, copying and ASAR regression covers both a retained probe and cleanup after inventory. Its native filename and byte sentinels verify selection; actual native loading and installed packaging remain separate gates. See the [incident](../../../postmortem/0202-desktop-dependency-walk-included-volatile-probe-homes.md).
