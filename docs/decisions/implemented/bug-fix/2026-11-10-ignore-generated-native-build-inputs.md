# Decision Record: Ignore generated native build inputs in build identity

Status: implemented

## Problem

Native preparation creates compiler targets, PTY receipts and sandbox assets inside workspace directories. The producer includes those generated files in the shared build identity, while consumer jobs restore the published bundle before native preparation runs. A valid build therefore fails input validation even though the generated outputs are already carried by the bundle.

## Decision

The shared build identity ignores native `target`, `.artifacts` and `sandbox-assets` directories during workspace source traversal. Native source manifests and implementation files remain covered, and the published output inventory continues to carry the verified PTY, watcher and sandbox artifacts. A regression creates representative generated files after publication and requires the identity to remain unchanged.

## Alternatives considered

**Prepare native outputs in every consumer before restore.** Rejected because restore is the boundary that supplies verified outputs to consumers; rebuilding first would duplicate work and could hide a mismatched producer artifact.

**Include generated native files in the manifest's source identity.** Rejected because those files are platform-specific outputs and are already represented by the manifest's output hashes and modes.

**Ignore the whole local-runtime workspace.** Rejected because its source code, native build scripts and sandbox implementation are build inputs that must invalidate stale artifacts.

## Consequences

Shared build identities remain independent of runner-local native preparation state. Source changes under the native crates or sandbox helper still invalidate the bundle, while compiler targets, receipts and copied assets can differ between producer and consumer lifecycle points without false rejection. The output manifest remains the authority for generated native bytes.
