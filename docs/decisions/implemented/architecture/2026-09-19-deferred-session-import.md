# Decision Record: Deferred Session Import

Status: implemented

## Problem

The [transactional agent authority](2026-09-14-transactional-agent-authority.md) upgrade runs backup, full JSON import, domain migrations, relationship validation and retirement serially before the server listens. Measured on a real fixture, a 6.1 GiB / 195k-file Home takes 364s of blocked startup, the preflight disk budget asks for up to 20 GiB of free space, and one corrupt global record blocks activation entirely. Every existing user pays this wall exactly once, and the heaviest homes — the ones with the most to lose — pay the most.

## Decision

The storage manifest carries an optional `compatBoundary` field, fixed when the manifest is first created (opt-in via `SYNERGY_STORAGE_COMPAT_DEFER=1`), so a crash and resume can never flip between retiring and keeping the session tree mid-migration. When set, activation defers the session aggregate tree `data/sessions/**`: the sealed backup still covers it, but the packed importer skips its records and rollout binaries (counted as `deferred`), and retirement leaves the JSON and binary files on disk. Activation seeds one stat-only locator record per aggregate directory (`compat_import/sessions/<sessionID>`); hashing every pending rollout blob here would re-create the cost the deferral exists to remove.

A deferred aggregate imports as one unit on first touch — `SessionManager.getSession` and the endpoint resolution path trigger the import before reading `session_index`, because the activation-time index rebuild only sees imported sessions. The per-aggregate importer checkpoints every file's hash (`compat_import/files/...`) in committed batches, so an interrupted import resumes without duplication; rollout binaries go through artifact packs with the bytes committed before their references. Parse or validation failures quarantine exactly that aggregate (`storage_recovery` evidence plus a `quarantined` locator) and surface as a blocked-session error on touch, instead of blocking activation for everyone. After import, the aggregate's migrations re-run through a replay registry — per-session extractions of the session-domain migrations, sharing one implementation with the global migrations and never writing the domain migration log — and the importer writes current-shape session index, page, child, nav and endpoint entries plus a search dirty mark, so the session is visible without a global rebuild.

Listings merge both worlds: nav, page and child index reads, and the session list, project pending aggregates from their `info.json` until they import. The startup tripwire becomes ownership-aware: JSON outside the deferred tree, or JSON under an imported (or unknown) session, is a fatal foreign writer, while JSON under a not-yet-imported aggregate is expected. Storage-target migration refuses to run while deferred aggregates remain.

Convergence is a runtime-internal idle task: the SQLite driver enforces single-process ownership, so an independent migrator daemon cannot open the store. The runtime starts a paused-able ticker (pause file `data/storage/compat-pause`) that imports oldest-first under a per-tick budget and stops when no pending locators remain.

## Alternatives considered

**Keep the full eager import and only optimize it.** Sampling retirement hashes, parallelizing session migrations and removing redundant artifact recompression cut the measured 364s to roughly 150s but keep a minutes-long blocked startup, the large transient disk budget and the all-or-nothing failure surface for exactly the homes least able to tolerate it.

**Run the background import in a separate daemon process.** The storage driver's single-process ownership lock rejects a second process outright; ownership recovery, lease and crash semantics would all need duplicating for no benefit over an in-runtime idle task.

**Mirror SQL writes back to JSON during the compat window.** A permanent mirror reintroduces the second authority that the transactional authority decision explicitly rejected; deferral keeps JSON read-only-after-activation by construction.

**Defer session-adjacent records too (`session_index`, `operations`, `snapshot-v2`).** The JSON freeze invariant means these have no legacy writer after activation, so eager-importing them is safe; deferring them would only add dangling-reference windows and a wider replay surface.

## Consequences

First startup on a legacy Home drops from minutes to seconds — the eager scope is the light non-session records plus one stat per session — while total import work is unchanged and spreads across idle time. The cost is a compat window with real obligations: every session-domain migration that touches session records must ship a per-aggregate replay, session JSON survives until convergence so the sealed backup's session state goes stale relative to touched sessions, official downgrade within the window returns sessions only as of the backup, and storage transfer waits for convergence. Removal of the mechanism is safe once the upgrade cohort has converged: the boundary field, locator records and merge paths are additive and inert on homes without them.
