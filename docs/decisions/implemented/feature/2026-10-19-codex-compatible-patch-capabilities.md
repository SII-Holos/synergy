# Decision Record: Codex-compatible patch capabilities with governed Workspace effects

Status: implemented

## Problem

The patch interface adopted Codex syntax but required unique byte-exact context. Ordinary model-produced patches with two-space indentation drift failed despite an unchanged, already-read source. Missing, repeated and backwards context shared one error, making recovery unnecessarily uncertain. Add and Move also rejected existing destinations and Move could not create parent directories.

## Decision

The pure Util parser and matcher adopt the pinned [Codex patch implementation](https://github.com/openai/codex/tree/160b2b1ef62114eeb41e41e5e3be0000d944b713/codex-rs/apply-patch/src), including source-ordered exact, trailing-whitespace, surrounding-whitespace and limited Unicode normalization passes. Each pass chooses its first forward match. Parsing accepts implicit first chunks, bare empty context, structural-marker whitespace, the upstream EOF heredoc wrapper and context-free append. These semantics supersede the strict matching portion of [independent file interfaces](../architecture/2026-10-15-independent-file-tool-groups.md); its interface selection and permission decisions remain applicable.

Synergy retains its object-root tool schema, selected Workspace, current Session read fingerprints, conditional publication, regular UTF-8 file requirement, alias/dependency rejection and original BOM/line-ending/terminal-newline preservation. Parser tolerance never selects another Environment or bypasses path classification. The Policy worker and executor share the same grammar. Text data files obtain read evidence based on their bytes rather than a binary-looking extension.

Add can replace an observed existing file. Move can replace an observed destination and create parents. Move writes the destination with its own preconditions, records the confirmed write, accepts formatter output through the existing process owner, then conditionally removes the unchanged source. A short-lived observation tracks formatter successors and rejects arbitrary listener replacements before deletion; it is not persisted or replayed. New destinations retain source permissions through optional, validated write modes; overwritten destinations retain their own permissions. Absent modes preserve existing operation digests, and interrupted writes with an explicit mode require both matching bytes and permissions before confirmation. The operation ledger names each actual target; per-file diffs compare destination content against its own original bytes and record source deletion only after confirmed removal. Full patches remain distinct from bounded previews. Unknown or unsaved effects stop execution without replay. Tool cards and Review consume those recorded file effects, with historical single-file receipts remaining readable.

The portable upstream scenario corpus is pinned with its source identity and license. One fixture deliberately retains Synergy whole-plan preflight: a validation error has no target effects. An additional unterminated-input variant asserts that Update preserves the missing terminal newline. Other original upstream expectations remain unchanged. Additional tests cover model-field indentation drift, match-tier priority, repeated anchors, Unicode whitespace, source-order recovery, protected destinations, stale overwrites, object revisions, permission preservation and uncertain operation receipts. Selected-view output size failures reject the whole plan before any target or parent creation, using the existing host limit rather than a new native limit. A controlled provider drives the real Session tool loop through reading, Move, rejection, rereading and repair, verifying delivered results and persisted effects. These establish tested patch behavior, not a model-level failure-rate or latency improvement.

## Alternatives considered

**Keep strict context matching and strengthen the prompt.** Rejected because the historical indentation failure is accepted by the upstream matching algorithm, and rereading the same file did not prevent repeated failure. Hunk-level diagnostics remain useful for genuinely invalid source order.

**Replace the selected-view executor with the upstream CLI.** Rejected because it would create a parallel filesystem authority without Synergy Workspace selection, fingerprint checks, durable operation identity or existing permission integration.

**Add a provider-specific freeform tool transport.** Not required for the file operation capabilities and incompatible with the current shared object-root tool contract. The patch string remains portable across providers; transport redesign requires its own end-to-end evidence.

**Treat an entire patch or Move as a transaction, or retry after an uncertain result.** Rejected because the native and selected-view mutation owners cannot provide that guarantee. Explicit destination-write/source-delete stages preserve recoverable partial effects without repeating writes.

**Accept any regular destination observed after file-edited callbacks.** Rejected because an unrelated replacement could become the authorization baseline for deleting the source. Deleting before formatting would avoid that callback window but discard source retention when formatting or post-write validation fails. The existing formatter owner instead advances the in-flight observation; normal and atomic-replacement formatters remain supported without another execution stack.

## Consequences

Model-produced context is more tolerant, but the first-match rule can select the wrong occurrence when a patch supplies insufficient context. The tool description requires enough original context and source ordering; version checks protect freshness, not user intent. Existing targets still require a read, binary/symlink targets remain unavailable, and inter-section path dependencies remain rejected. These host constraints are separate from the upstream patch-language capability comparison and must remain visible in documentation and tests.

Move can leave a committed destination and an unchanged source after failure. Each stage and real file diff remains available to recovery and Review. Cross-file checks cannot prevent uncoordinated external filesystem writes between validation and removal or attribute every write made while a trusted formatter process runs. A successful upstream fixture or deterministic model fixture is not proof of overall task success on arbitrary models or filesystems.
