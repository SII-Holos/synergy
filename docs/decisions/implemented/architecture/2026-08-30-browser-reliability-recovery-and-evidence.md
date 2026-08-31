# Decision Record: Browser reliability recovery, settle, and evidence

Status: implemented

## Problem

Browser spans one owner/page model across headless control, Desktop-native presentation, and remote WebRTC presentation. Renderer failures, Host disconnects, dynamic-page network activity, and lost command responses can otherwise cause duplicate pages, unbounded reloads, premature failures, or unsafe retries. Agents also need a stable distinction between dispatched input, page observations, and verified business outcomes.

## Decision

Strengthen the existing Protocol v2 owner/page path instead of adding a parallel recovery or automation model:

- `BrowserSession.resumePage()` is the idempotent recovery entry. A live backend handles `resume` without replacing a healthy native generation; an in-flight native recovery is awaited; a failed native recovery starts a new bounded flight and resets only its transient recovery budget. The canonical owner and page identity remain stable while the native `WebContentsView`, CDP control, and diagnostics generation may be replaced.
- Native recovery remains single-flight and bounded. Renderer loss, unexpected destruction, failed liveness, recoverable CDP failure, unresponsive reloads, and navigation watchdogs use bounded recovery rounds and a shared per-page budget. `restarting` and `failed` reject side-effect commands with `browser_native_restarting` or `browser_native_recovery_failed`; `resume`, `close`, and safe observations remain available. `ready` is emitted after the recovery guard clears, and native failure never selects WebRTC.
- `CdpPageController` owns settling. Agent navigation defaults to the main-frame `load` lifecycle with a 15-second deadline; settle-eligible actions default to `networkquiet` with a 10-second deadline; both have a 30-second hard cap and a 500ms quiet window. User navigation remains immediate, explicit settle options are honored, and requests already in flight when settling starts do not block a quiet result. A timeout is non-fatal and returns settle fields, current page state, and a best-effort accessibility snapshot capped at 500 nodes when readable.
- Tool results separate dispatch, settling, observation, and business completion. `browser_action` reports dispatched input and observed page state without claiming that an effect was saved, sent, or applied. `browser_navigation current` reports status and the last error without creating a page. `browser_wait` reports an observed condition, not business completion. Unknown outcomes instruct the caller not to re-execute the same call; ambiguous locators return at most five redacted candidates with diagnostic fields and usable `snapshotId`/`ref` values instead of selecting the first match.
- Browser observability uses the existing `ObservabilityEvents`, `ObservabilityMetrics`, `ObservabilitySpans`, `ObservabilityStore`, context, and redaction paths. Generic HTTP requests carry bounded route, correlation, trace, and request identifiers; frontend Browser metric batches are validated, redacted, and stored through `POST /performance/browser-metrics` and `obs_browser_batches`. Browser-specific command, recovery, settle, and reconnect coverage is not considered complete solely because these canonical APIs exist; runtime call sites and rollout evidence must be verified before making coverage or SLO claims.
- Protocol version 2 remains unchanged. Transient recovery budget, generation, settle state, command outcome, and locator candidates remain runtime state; no `sessions-v5`, Browser storage backfill, new user configuration knob, new recovery tool, or new recovery discriminator is introduced. Additive generated schema changes, where required by existing result/error fields, are regenerated from source and are not a data migration.

## Alternatives considered

- **Add a `browser_recover` tool or a new recovery command discriminator** — rejected: existing `resume`, command queuing, Desktop Retry IPC, and session restoration provide one recovery entry without expanding strict Protocol v2 parsing, tool registration, SDK generation, and old-Host compatibility risk.
- **Treat `resume` only as suspended-session restoration** — rejected: active-but-failed native pages would remain unreachable from the Agent path; the existing command gives healthy pages idempotent state access while also reaching bounded recovery.
- **Switch a failed native page to WebRTC or create a second page** — rejected: this violates managed-local native strictness, one-owner/one-page identity, ticket ownership, and the shared presentation model.
- **Replay an action after a timeout, disconnect, or lost response** — rejected: the side effect may already have happened, so replay could duplicate a send, save, upload, deletion, or other irreversible operation.
- **Increase only recovery budgets or timeouts** — rejected: larger limits can prolong a deadlock and hide the trigger; bounded probes, single-flight recovery, explicit states, and evidence provide a safer failure path.
- **Use one network-quiet policy for every navigation and action** — rejected: long-polling and continuously active pages need a bounded load-based navigation result, while actions need a short quiet window; neither should wait indefinitely.
- **Put settle loops or recovery retries in tools or the Agent worker** — rejected: those layers do not own page lifecycle, inflight requests, or renderer state and could create duplicate waits or side effects; settling stays in `CdpPageController` and recovery stays with Session/Host owners.
- **Create a Browser-specific telemetry database or let Performance control lifecycle** — rejected: the canonical observability stores already provide redaction, retention, correlation, and query paths; Performance remains read-only and cannot close pages or stop Hosts.
- **Persist transient recovery state or upgrade Protocol v3** — rejected: budget, generation, settle, and candidate data are ephemeral, and the behavior fits Protocol v2 without a storage migration or wire-version break.

## Consequences

The same owner and page remain addressable through native recovery, but renderer-local uncommitted DOM and form state are not preserved when a generation is replaced. Automatic recovery can end in an explicit failed state, so callers must use `resume`, native Retry, observation, or close rather than retrying an ordinary side effect.

Bounded settle returns useful partial evidence for dynamic pages, but a snapshot is best effort and a settled page is not proof of a business postcondition. Redaction and cardinality limits make telemetry safer and cheaper at the cost of omitting private values and some diagnostic detail; Browser-specific metric coverage and production SLO baselines require separate runtime and release verification.

Migration impact is none for Browser persisted state: `sessions-v4` remains the storage version, no Browser backfill runs, and transient recovery, settle, outcome, and locator data are not persisted. Additive generated API artifacts, if produced from the existing schemas, do not require a user data migration.

Verification expectations include focused controller settle and ambiguity tests, Session/Host recovery-gate tests, Desktop native pool fault-injection tests, Browser tool evidence tests, the Agent-worker runtime-boundary test when shared Browser utilities change, and `bun run doc:check`, `bun run decision:check`, and `bun run skill:check`. Isolated headless, native, and WebRTC runtime checks must confirm same owner/page identity, no automatic replay of unknown outcomes, native-only managed-local presentation, bounded recovery, and redacted observability; release SLO or baseline claims require their own measured evidence.
