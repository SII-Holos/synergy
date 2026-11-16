# Decision Record: Verify portable Assets and tool output dependencies

Status: implemented

## Problem

Copying canonical Session records leaves references to Assets and retained full tool outputs outside the Session subtree. Display previews and their bounded reference lists cannot establish this dependency closure. A target may also retain a conflicting output ID or lose its volatile preparation evidence on restart.

## Decision

Register `SessionTransferEvidence` as an explicit portability owner for a root aggregate. Source sealing requires exact frozen epoch bindings for the root and supplied members. A disk-backed traversal checks the registered owners' complete child graph and rejects missing or unreachable members. The sealed index retains member owner versions and counts, deduplicates immutable resources across the subtree in SQL and exports one resource copy with its complete checksum and length. Changed source owner versions require renewed preparation.

The native core enumerates managed references from retained records, complete text and reasoning, recovery summaries and full output artifacts. It follows native Rollout input, original-result and observation artifact identities, so a reference present only in the retained original result is included. Canonical StoredToolOutput references are resolved through their owner; their original bytes are inspected for rendered Asset references before the resource becomes complete. Exact historical aliases retain their strings and mappings without becoming target filesystem paths. A complete native output artifact is the original observation; its historical output path does not require another copy. Partial evidence remains partial and transfer does not reconstruct unavailable original bytes. Retained native truncation files need a separate streaming output-owner integration; their old paths are not treated as canonical output records.

The global Asset and StoredToolOutput owners do not establish organization project provenance. Seeing a hash or an old output alias in organization history therefore grants no source access. Evidence sealing requires a trusted composition-registered source authority for every dependency of an organization aggregate, including bindings omitted from the selected Session projection. Authorization runs before opening the global object and before resource deduplication, retains each member's origin and runs again before export or reuse of a sealed manifest. Descendants inherit this aggregate requirement even if their own projected binding is absent. No permissive organization authority is registered by this foundation. Production producer provenance, target adoption authorization and signed handoff consent remain required integration work. The current shared transcript exporter does not automatically dereference Markdown Asset links; this decision does not add such an upload path.

Use a complete Markdown reference traversal through the existing lexer. It preserves rendered links, images, reference definitions and code semantics without the display extractor's character or reference budgets. Repeated occurrences remain available to the caller, which performs disk-backed deduplication. The parser still materializes one complete field and its token tree; source preparation memory therefore scales with the largest parsed field. Bounded transport frames and SQL resource indexes do not remove that separate residency cost.

Target validation checks exact metadata, counts, aliases, content hashes, tool-output encoding and existing destination identities. Asset content installs through its canonical owner before Session activation. Imported Session records and output aliases remain private until the aggregate activation transaction. Preparation proofs belong to the exact Runtime and staged owner context; failed revalidation clears them. Restarted prepared targets revalidate their persistent staging and rebuild the proof before publishing. A collision cannot overwrite an existing unrelated output.

Frozen source history remains immutable during shutdown and cold Rollout preparation. Those paths skip ordinary recovery for a transfer-frozen owner and preserve its unresolved recovery coverage for the eventual authorized destination or cancelled source. They neither rewrite a recovered receipt nor declare uncertain history clean.

This owner covers Assets and canonical full tool outputs. Historical snapshot roots require the separate `session-snapshots` owner; core preparation reports its absence. Snapshot object ownership, WorkspaceMove, organization command receipt rebinding and signed Runtime coordination retain their own owners. This owner does not register itself into production composition or imply that an organization handoff is complete.

## Alternatives considered

**Reuse display references.** Those references intentionally stop at display budgets and can omit original-output dependencies.

**Retain one in-memory set for the aggregate.** Memory would grow with the subtree and object count.

**Read an alias as a target path.** An old device path is historical evidence and does not grant target filesystem access.

**Treat existing files as a prepared receipt after restart.** Their presence does not prove member compatibility, complete staging or current activation authority.

## Consequences

Real temporary Homes verify subtree deduplication, references beyond display budgets, Assets present only in complete outputs or original Rollout results, missing children, missing source objects, destination collisions, rollback of the full activation, failure invalidating a previous proof and target restart. Organization tests verify absent authority rejects before an object read, shared-resource deduplication does not bypass a child's denied authority and revocation prevents export. Shutdown and reopen preserve frozen record checksums and pending recovery. Assets can be independently readable before Session visibility; output aliases and canonical Session records appear only after paused publication. Source cancellation leaves the original Session paused. Large-field Markdown/JSON residency and complete snapshot transport remain explicit integration work.
