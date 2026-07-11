# Knowledge: Library, Notes, and Blueprints

Synergy separates reusable learned context from authored documents.

- Library stores long-term Memory and learned Experience that can be recalled into model context.
- Notes store documents that a user or agent intentionally authors and revises.
- Blueprints are Notes with an execution-oriented contract and workflow restrictions.

These are complementary systems. A durable session transcript is not automatically a Note, and a Note is not automatically model memory.

## Library

Library is global to the Synergy installation. Its SQLite database stores Memory and Experience, with `sqlite-vec` indexes when vector search is available. Entries retain their semantic Scope where relevant even though the database is shared.

Vector indexing is fail-soft. If the extension or a vector table is unavailable, Synergy keeps the underlying records usable and can fall back to non-vector behavior where implemented; it does not treat the whole Library as unavailable.

### Memory

Memory is explicit long-term context. Each entry has a title, content, category, recall mode, embedding model, and timestamps.

Categories describe what the memory means:

- identity and relationship: `user`, `self`, `relationship`, `interaction`
- reusable knowledge and work: `workflow`, `coding`, `writing`, `asset`, `insight`, `knowledge`, `personal`, `general`

Recall mode controls automatic use independently of category:

- `always` — inject on every eligible session turn
- `contextual` — retrieve semantically when the current request needs it
- `search_only` — never inject automatically; retrieve only through an explicit memory search

The separation matters: category answers “what is this?”, while recall mode answers “when may it enter context?”

Top-level sessions receive always-on Memory plus eligible contextual retrieval. Child sessions receive the always-on Memory block but do not independently perform the full experience/contextual recall path. Agents can use Library tools to search for additional `search_only` or non-retrieved context.

### Experience

Experience is learned from completed top-level turns. Synergy distills the user's intent and the execution trajectory, stores source model and Scope metadata, and records which earlier experiences were retrieved for the turn. Synthetic turns and child-session turns are not encoded as new experiences.

An experience retains:

- sanitized intent
- a distilled trajectory script and bounded raw digest
- intent and script embeddings
- source session, Scope, provider, and model
- reward status and reward dimensions
- learned Q-values, visit count, and history
- IDs of experiences that influenced the turn

The reward dimensions are outcome, intent understanding, execution, orchestration, and expression. Their configured weights produce a composite reward, while per-dimension Q-values evolve as related outcomes are observed. This supports retrieval based on both semantic similarity and accumulated usefulness rather than treating every past turn equally.

Memory and Experience retrieval run in parallel during prompt preparation. An embedding failure does not prevent always-on Memory from being injected; experience retrieval simply contributes no result when its required vector path is unavailable.

When the session loop detects the same context-pressure signal that can initiate compaction, the hidden `chronicler` may start a silent, unattended child session. It receives the current model-visible conversation, searches existing Memory, and writes or refines durable knowledge when `library.memory.enabled` is active and its model role is available. This job is asynchronous and best-effort: it does not block compaction or guarantee that every conversation becomes Memory.

### Library Inspection

The Library surface exposes memories, experiences, filters, health, and aggregate statistics. Experience records can be inspected by Scope or session and sorted by recency, reward, learned value, or visits. Failed encodings remain detectable and can be retried without discarding their reward history. The adjacent Usage view summarizes session and tool activity rather than Library records; see [Activity and Statistics](activity-and-statistics.md).

## Notes

Notes are TipTap documents stored in either the home Scope or a project Scope. A Note includes title, document content, tags, pinning, archive state, version, timestamps, and whether it is global.

A project view combines its own Notes with global Notes from the home Scope. The original Scope still owns each record. Pinning changes prominence, not ownership.

Updates use an expected version so concurrent edits cannot silently overwrite one another. Archive is a reversible state; deletion removes the record after the caller deliberately chooses that stronger action.

Agents can create, read, search, edit, archive, restore, and delete Notes through note tools. The Web product uses the same underlying records.

## Blueprints

A Blueprint has `kind: "blueprint"` and can add a description, default execution agent, and audit agent. Its content is an authored, decision-complete plan intended for later execution.

Blueprints remain readable everywhere, but note tools may create or modify them only while the session is in Plan or Lattice. This prevents an execution session from quietly rewriting the contract it is supposed to satisfy. BlueprintLoop stores the selected note ID and optional version separately from the Note itself, so execution history and document history remain distinct.

For the full lifecycle, see [Workflows](workflows.md) and the [workflow runtime](../architecture/workflows.md).

## Boundaries

- Session messages are durable work history; Library is reusable recalled context.
- Memory is deliberately managed context; Experience is learned from completed work.
- Chronicler is asynchronous Memory curation triggered by context pressure, not a second transcript or a guaranteed per-turn hook.
- Notes are authored documents; they are not injected automatically merely because they exist.
- Blueprints are executable Notes; BlueprintLoop is the runtime that executes and audits them.
- Scope ownership is preserved even when global knowledge is visible from project contexts.
