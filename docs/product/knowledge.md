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

The Library surface exposes memories, experiences, filters, health, and aggregate statistics. Experience records can be inspected by Scope or session and sorted by recency, reward, learned value, or visits. The adjacent Usage view summarizes session and tool activity rather than Library records; see [Activity and Statistics](activity-and-statistics.md).

### Encoding Health and Re-encoding

Experience encoding can degrade over time — an intent may be too long, empty, copied from raw user text, or lost during a failed pipeline step. The Library settings `Encoding health` panel runs a detection scan grouped by reason, then allows the user to start a durable server-owned re-encode job.

A re-encode job processes each candidate experience and updates its intent or script embedding. The job is owned by the server, not the frontend: closing the settings panel or disconnecting the browser does not cancel it. At most one job is active at a time. Starting a new job when one is already running returns the existing job state with a 409 conflict.

The worker bounds maintenance memory by separating candidates that already have stored raw content from candidates that need session history. Ordinary script repairs use the stored Library content without loading session messages. Intent repairs and complete failed-pipeline repairs are grouped by session: the server loads one session history, processes that session's candidates, releases it, and only then advances to the next session. Cancelling a job also propagates to in-flight encoder and remote embedding requests. Between session groups, critical process or cgroup memory pressure triggers collection; if collection is unavailable or pressure remains critical, the job fails before loading another history.

REST endpoints support the full lifecycle:

- `POST /library/experience/reencode/jobs` — start a job (`intent` or `script` type, with an optional detection reason filter)
- `GET /library/experience/reencode/jobs/current` — poll the most recent job's aggregate status and counts
- `POST /library/experience/reencode/jobs/current/cancel` — cancel the active job without discarding already-completed results

Items transition through `pending` → `processing` → `ok | skipped | failed`. A job finishes as `completed`, `failed`, or `cancelled`. If the server restarts while a job is running, startup reconciliation resets in-flight `processing` items to `pending` and marks the job `interrupted`; the user can start a new job to continue where it left off. Explicit cancel keeps completed results and only resets unprocessed items. The legacy SSE `POST /library/experience/reencode` endpoint remains as a compatible observer stream that starts or attaches to a running job.

Three `library.experience.learning` configuration fields control the job runtime:

- `reencodeConcurrency` (1–32, default 5) — how many stored-content script repairs may run in parallel; history-dependent repairs remain serialized by session so only one complete session history is retained at a time
- `reencodeRetries` (0–10, default 3) — how many times to retry a transient model, embedding, session, network, or database stage before marking the item failed
- `reencodeRetryBackoffMs` (≥ 0, default 1000) — initial backoff in milliseconds for transient retries, doubled on each attempt (1s, 2s, 4s by default)

## Embedding Model

Synergy uses an embedding model to produce vector representations of text for semantic memory retrieval, experience recall, and Library search. Two modes are available, selected automatically by configuration:

Settings → Library → Memory always shows the effective embedding model. A user-configured remote model is shown as configured and takes precedence; when no remote embedding API key is configured, the bundled local model is shown as the default fallback.

### Local Mode (default, zero-config)

When no `embedding.apiKey` is configured, Synergy uses the bundled `Xenova/all-MiniLM-L6-v2` model running locally via `@huggingface/transformers`. The model is approximately 80 MB and produces 384-dimensional vectors.

**Lazy loading**: The local model is not preloaded at startup. It loads on first use — the initial embedding call triggers a one-time download and pipeline initialization. Subsequent calls reuse the warm runtime.

**Explicit download**: Run `synergy embed download` to fetch the model assets ahead of time. The command shows the configured download source and live byte/percentage progress. After a successful download, embedding calls start instantly.

**Status**: `GET /library/embedding/status` reports the current embedding mode. Every response includes `mode` (`"local"` or `"remote"`) and the configured `model`. Local mode also includes:

- `source`: download source (`huggingface`, `hf-mirror`, or `custom`)
- `asset`: `"missing"`, `"downloading"`, `"cached"`, or `"failed"`
- `runtime`: `"unloaded"`, `"loading"`, or `"ready"`
- `progress`: optional byte/percentage snapshot while downloading
- `error`: optional error detail if a load or source validation failed

Remote mode includes `baseURL`, the configured embedding API endpoint.

Status is in-memory: the local cache is probed on demand but status from a prior runtime is not persisted. After a server restart the model is re-inspected when next needed.

**Download API**: `POST /library/embedding/download` starts or joins the local model download and returns the current observable status. It returns 409 when a remote embedding service is configured — no local download is needed in that case. There is no cancel or SSE endpoint.

### Remote Mode

When `embedding.apiKey` is configured, Synergy queries a remote embedding API. The bundled local model is unused. `synergy embed download` exits immediately with a message that no download is needed. The remote provider defaults to SiliconFlow with `Qwen/Qwen3-Embedding-8B` but any OpenAI-compatible endpoint works through `embedding.baseURL` and `embedding.model`.

Set up remote embedding with `synergy config embedding` or through the Web Settings Embedding page.

### Download Source

The local model downloads from Hugging Face Hub by default. The source is configurable through the General domain (`00-general.jsonc`):

```jsonc
{
  "embedding": {
    "local": {
      "source": "huggingface",
    },
  },
}
```

| Field                        | Meaning                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `embedding.local.source`     | `"huggingface"` (default), `"hf-mirror"`, or `"custom"`                                                                                                       |
| `embedding.local.remoteHost` | Required when `source` is `"custom"`; must be a public HTTPS origin with no credentials, path, query, or hash. Local/private/loopback addresses are rejected. |

The model ID, quantization dtype, and cache directory are not exposed as configuration.

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
