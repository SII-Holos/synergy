# Decision Record: Ignore generated locale catalogs in build identity

Status: implemented

## Problem

The Web build generates locale catalogs named `messages.mjs` under an ignored source directory. The build producer creates those files before publishing the shared build manifest, while a consumer restores the manifest before Web setup runs. Including the generated files in the source identity therefore makes a valid shared build fail the restore check on every consumer runner.

## Decision

The shared build identity ignores generated `messages.mjs` files together with other build outputs and local caches. The source `.po` catalogs and the generator configuration remain identity inputs, so changing translation source or generation behavior still invalidates the build. A regression adds a generated catalog after publication and requires the identity to remain unchanged.

## Alternatives considered

**Generate locale catalogs before every restore.** Rejected because restore is deliberately the first consumer step and should not depend on installing or running the Web toolchain.

**Publish generated catalogs as build inputs.** Rejected because they are derived files, are already ignored by the Web workspace, and differ between producer and consumer lifecycle points.

**Remove all locale files from the identity.** Rejected because source catalogs and generator configuration are authoritative build inputs and must invalidate stale Web artifacts.

## Consequences

Shared build manifests remain portable across the producer and consumer lifecycle. Locale source edits continue to invalidate the manifest, while generated catalogs can appear or disappear after publication without causing a false mismatch. The identity exclusion is intentionally limited to the generated filename; unrelated source files remain covered by the existing recursive inventory.
