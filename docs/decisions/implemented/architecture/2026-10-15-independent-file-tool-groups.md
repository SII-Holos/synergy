# Decision Record: Independent scoped file interfaces

Status: implemented

## Problem

File syntax was coupled to built-in Agent permission lists. Changing roles changed the interface, optional syntax search duplicated discovery, and the published legacy patch helper did not provide governed selected-Workspace mutation semantics.

## Decision

The Scope's ordinary configuration resolves one closed `fileToolGroup`, with `patch` as the universal fallback. Tool membership narrows the common catalog before initialization; permissions and component availability narrow it further. Readers and writers share semantic read/edit permission lookup while retaining concrete identities and ordered user-rule precedence. Agent, model and Session settings do not select the interface.

Native patch execution uses a pure grammar shared with the Policy worker and conditional selected-view writers. Full preflight precedes sequential commits. Coherent fingerprints allow dormant object tokens to refresh across unrelated revisions without accepting changed targets. Every committed or unresolved stage survives partial failure and cancellation in result metadata and rollout evidence. Public precise search uses existing selected-view engines; deprecated search wrappers remain importable but unregistered.

The authoritative member table, patch guarantees and search behavior live in [Workspace and files](../../../architecture/workspace-and-files.md#file-tool-interfaces). The grammar cites its pinned upstream language reference beside the implementation. Object-schema input, strict ambiguity checks, selected-view effects and partial-state projection are local adaptations.

File-change result views reuse the Review diff renderer for edit, revise_file and apply_patch, with file headers, counts, line numbers and highlighting. A bounded unhighlighted code view remains readable while highlighting loads. Revise metadata records each file's observed post-formatter diff separately, avoiding synthetic cross-file line numbers. Results omit per-file outcome prose and operation ledgers. Partial and unconfirmed outcomes stay in the detail header; native input, complete receipts, execution metadata and diagnostics remain copyable in diagnostics. Historical diffs retain their recorded file identity, and text-only calls keep their fallback. No display projection becomes mutation or undo authority.

## Alternatives considered

**Agent- or model-dependent defaults.** Rejected because they preserve multiple selection owners. All roles resolve the same Scope setting while retaining their authority.

**Permission denies as interface selection.** Rejected because authority is independent of syntax. Existing explicit restrictions remain intact and can make a selected writer unavailable.

**A command backend or the legacy raw-filesystem patch executor.** Rejected because neither owns selected Workspace admission, authorization, conditional publication and history.

**Atomic multi-file commits or automatic rollback.** Rejected because current native and remote contracts do not support that guarantee. The result must describe partial effects instead.

**Delete deprecated package exports, or leave them executable by default.** Both rejected: stopped first-party registration reduces the callable surface while retained wrappers and historical rendering preserve import/history compatibility.

## Consequences

The default intentionally changes prior interfaces. Permission-only configurations must select the group explicitly; no migration guesses intent or removes denies. Ordinary patch read evidence protects freshness but does not claim Hashline's displayed-line guarantee. Sequential patches can leave committed files and created parents after failure. Recovery requires inspecting those effects and reconciling existing operation identities. This decision makes no comparative model-performance claim.
