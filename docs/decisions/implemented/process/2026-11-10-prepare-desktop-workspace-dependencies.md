# Decision Record: Prepare desktop workspace dependencies in Windows CI

Status: implemented

## Problem

The Windows desktop CI unit installs only the desktop workspace and does not restore the shared Linux build artifact. Desktop sources now import workspace packages whose `import` exports point at generated `dist` files, so a clean Windows checkout can reach the desktop build without those files.

## Decision

The Windows desktop CI unit selects the desktop, SDK, and util workspaces during dependency installation, then builds `packages/util` and `packages/sdk/js` immediately before running its planned tests. The SDK build invokes its local TypeScript binary directly so the nested compiler lookup is portable across CI shells. These are the workspace outputs and build-time tools required by the desktop bundle's node-targeted imports; release and shared-build paths continue to own their existing broader build preparation.

## Alternatives considered

**Restore the shared Linux build artifact for Windows.** Rejected because the artifact is platform-specific and the Windows unit does not need the full web or native build graph.

**Change published package exports to point at source for every Bun desktop build.** Rejected because published `import` consumers must continue to receive generated runtime files, and changing that contract would expand the compatibility surface beyond CI preparation.

**Run a full monorepo build before Windows tests.** Rejected because it would duplicate unrelated workspace work and lengthen the focused Windows job without adding coverage.

## Consequences

The Windows desktop job performs two small deterministic workspace builds and can resolve the SDK and util package exports from a clean checkout. Desktop CI remains independent from Linux artifact transport, while the job pays the cost of generating the two required `dist` trees.
