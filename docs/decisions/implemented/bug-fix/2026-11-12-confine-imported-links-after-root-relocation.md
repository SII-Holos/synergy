# Decision Record: Confine imported links after root relocation

Status: implemented

## Problem

A validated imported tree can contain a literal link whose normalized target stays inside its captured entry root but depends on that root's name. Renaming the root while retaining the literal target can redirect the link outside the selected destination. Validating only the source tree does not establish destination containment.

## Decision

`WorkspaceTree.importHeader` owns path relocation and import-specific link containment for canonical entry headers. It requires the captured `entry` prefix and checks the literal link target in both the source and destination. It preserves supported targets verbatim and rejects a relocation that would leave the destination. It returns file metadata without a legacy chunk array.

Bounded legacy `importEntries` retains full manifest validation and the required entry root, then delegates each path to that same operation. Paged consumers can apply the same rule incrementally to metadata already validated by the canonical portable reader. This operation grants no storage, filesystem or publication authority.

## Alternatives considered

**Validate only the source.** A root-dependent relative target changes meaning when that root is renamed.

**Rewrite link text during relocation.** That silently changes captured link bytes. Unsupported relocation is rejected instead.

**Duplicate checks in every importer.** Legacy and paged imports would have different accepted path and link semantics.

## Consequences

Imports with ordinary contained relative links preserve their exact targets. A name-dependent link may require explicit source repair before import. Header relocation stays independent of body references and does not reconstruct per-file chunk inventories. See [the incident](../../../postmortem/0127-imported-link-followed-its-source-root-name.md).

## Verification

`test/workspace/tree-import.test.ts` first reproduced a contained source link pointing outside a renamed destination. It verifies nested destinations, identical legacy/header paths, unchanged safe link text, rejection of a foreign source prefix and traversal destination, and omission of legacy chunk arrays from file headers. Existing object-content mutation tests retain ordinary import behavior.
