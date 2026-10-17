# Frontend residency and projection measurements

This reference records the local production-browser experiment for [bounded residency and projections](../decisions/implemented/architecture/2026-10-12-frontend-residency-projections.md). Implementation invariants belong to [frontend data synchronization](../architecture/frontend-data-sync.md); the reproducible fixture and commands are in the [benchmark reference](../../apps/web/test/performance/README.md).

## Scope and method

The baseline is commit `41ca2852fc2d6e87db72a5d8bd63ccb8e8847d9f`, before this task's changes. The integrated candidate is `a83faf39dc8ae8a955e8e4b34cce03fee88c6d48`. This is not a measurement of release 3.0.22. Both builds use the same lockfile, Bun 1.4.2, fixture runner and synthetic input. The frozen baseline and candidate run sequentially, each with one isolated Runtime serving its built Web UI and a fresh temporary Home. The user's running instance is excluded.

The device is an Apple M5 Pro on macOS Darwin 25.6.0 arm64, using Playwright Chromium 149.0.7827.55 at 1728 × 1080 without CPU throttling. The workload contains three Scopes, twelve primary Sessions, 1,056 historical messages including one 550-message history, one turn with 2,001 tool Parts, two child Sessions, Notes, a large Markdown file and two simultaneous 300-chunk text streams. No model provider is invoked.

Each run warms three cross-Scope targets before thirty switches. Readiness requires visible target text. Request counters exclude warm-up; streaming bytes exclude navigation. Timing is a device observation. Shared CI checks deterministic bytes, requests, ordering and lifetimes rather than a machine-speed assertion.

## Integrated changes

Four changesets are reconciled with the resident Session and resource owners. Their frozen inputs were checked against the source worktrees after integration.

| Area                 | Integration commit | Preserved behavior                                                                                  |
| -------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| Conversation reading | `e1c90d091`        | Keyed virtual measurements, history anchors, process reading and the single floating latest control |
| Native Browser       | `6e97177d8`        | Session-local tabs, shared profiles, popup association and menu visibility above native content     |
| Agenda and controls  | `f2f081355`        | Global Agenda scope, neutral control feedback and stable Composer presentation                      |
| Task details         | `640b4d1aa`        | Explicit actions, one inspector scroll owner and repeated navigation to the current target          |

The outgoing transcript clone is superseded by resident views, as recorded in [Session navigation presentation](../decisions/implemented/bug-fix/2026-10-10-session-navigation-presentation.md). Identity isolation, no welcome-page flash and reading continuity remain required. Additional integration fixes measure new rows before following (`ae518d9a4`), pause hidden execution readers without remounting (`5b40060a9`) and release historical locations before latest navigation (`a83faf39d`).

## Results

| Measurement                      |  Baseline | Candidate |
| -------------------------------- | --------: | --------: |
| Stable streaming WebSocket bytes | 4,738,344 |   399,657 |
| Warm-switch Part body requests   |        73 |         0 |
| Warm-switch timeline requests    |        30 |         0 |
| Warm-switch readable P95         |  106.2 ms |   51.7 ms |
| Browser errors                   |         0 |         0 |

Stable streaming traffic falls 91.57%, exceeding the 80% target. In the baseline, thirty execution updates account for 3,698,739 bytes, approximately 78% of all streaming traffic. The final candidate also performs zero body requests throughout streaming, including terminal version checkpoints. It verifies every chunk from both streams in order, including the stream generated while its Session was inactive. Markdown validation scrolls rendered windows rather than assuming all document text resides in the DOM.

The production panel run holds the initial timeline response while the composer remains editable and workspace navigation opens. Notes retain their editor node and edits across Session switches. Files retain their reader node and a 350-pixel scroll position. Execution records retain their panel and search filter. Closing the real WebSocket while Notes are hidden causes zero hidden Note GET requests; reconnection preserves the editor on return.

Three rounds across all twelve Sessions retain six Session presentations. Evicted Sessions release their panels. Forced-GC heaps are 80,962,824, 82,287,928 and 79,122,224 bytes, showing a plateau rather than continuous growth. Behavioral panel tests separately open twenty resources and require the global eight-panel limit, retained selection and generation invalidation.

### Post-repair repeat

A repeat after the execution-context repair at `5a1680ce46b15a6f3e79b941d12c4599e3b30a63` exposed a fixture phase error: seventeen first-time body reads from the final warm-up target entered the hot counter. None repeated an earlier content request. Playwright's document `networkidle` state was already satisfied before the SPA switch. The runner now waits for observed Session reads to finish and remain quiet for 500 ms during warm-up only; hot-switch assertions and visible-text timing are unchanged. The failed sample is preserved separately.

The frozen baseline and repaired candidate were then run sequentially with this same corrected runner and the same synthetic input. Streaming bytes were 4,800,784 versus 398,234, a 91.70% reduction. Warm body reads were 100 versus zero, warm timeline reads were thirty versus zero, and readable P95 was 98.3 ms versus 40.4 ms. The candidate again performed zero streaming body reads, verified all chunks in both streams, preserved Notes/file/execution instances and reported no browser errors.

## Red and green evidence

| Invariant                                         | Observed failure before correction                                                                             | Verification                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Hidden virtual windows preserve reading position  | Late hidden scroll receipts replaced rows 150–159 with rows 0–5                                                | Real Virtua browser fixture retains the window and scrollTop 6000                                                                      |
| Hidden layout work pauses                         | Prompt dock observer published height zero after deactivation                                                  | Dock lifecycle and automatic-scroll tests preserve measurements                                                                        |
| Retained panel state does not self-trigger writes | Restored Notes caused repeated tab updates and a reactive stack overflow                                       | Workbench provider tests require one meaningful write; production Notes round trip succeeds                                            |
| Plugin registry refresh preserves accepted owners | Transient registry gaps invalidated retained views                                                             | Scope-generation and panel lifetime tests retain the same owner and evict changed generations                                          |
| Reconnect avoids hidden resource reloads          | Hidden Notes performed body and metadata reads after a socket close                                            | Production reconnect observes zero hidden Note GETs                                                                                    |
| Oversized checkpoints remain readable             | A body larger than the memory budget evicted itself                                                            | Immutable, Scope-fenced checkpoint tests cover spooling, concurrent release and bounded handles                                        |
| New projection removes repeated append work       | Compatibility checkpoints repeatedly transmit accumulated text                                                 | Deterministic 300-append comparison requires at least 80% fewer bytes                                                                  |
| Final checkpoints reuse complete streamed bodies  | The terminal checkpoint requested the entire body again                                                        | Version anchors preserve split surrogate pairs, metadata and canonical versions; equal-length edits still recover full content         |
| Detail activation shares work                     | Explicit opening and visibility restoration started two requests                                               | One pending read survives activation; hiding aborts it and rejects its late response                                                   |
| New row measurement precedes following            | A 33-pixel row initially contributed its 212-pixel estimate and caused a rebound                               | Both Virtua entrypoints combine real disclosure and automatic following; prepend compensation remains intact                           |
| Hidden execution readers retain accepted content  | Hidden reconnects issued HTTP reads, and unchanged inspector metadata recreated body readers                   | Session, panel and document activity cancel pending reads; loaded bodies and reader DOM survive; only unfinished ranges resume         |
| Latest navigation releases search ownership       | A search target still inside the latest window pulled the viewport 1,047 pixels from the bottom after resizing | Production pointer, Enter and Space paths search both inside and outside the latest window, then remain at the bottom across 24 frames |

Additional tests cover real multi-client WebSockets and released leases, independent detail revisions, cursor/epoch recovery, queue count/time budgets, late owners, deleted messages, and reconnect validation of 242 Parts in four disjoint loaded ranges. Obsolete whole-area-hidden and cloned-transition expectations were replaced with local-loading assertions while preserving owner, scroll and late-response protections.

## Verification and limitations

The integrated verification selects 79 behavioral test files and records 749 passing tests with no failures, including the browser crypto check. After the additional latest-location correction, the affected conversation, reading, retention, scroll-motion and production-host tests pass again. Real production navigation covers delayed preparation, editable cold shells, retained transcript DOM, Home identity, historical search, viewport resize and a changed body recovered after reconnect. Coverage thresholds remain unchanged; all nine newly measurable source modules have coverage records.

All 33 workspace type checks, lint, SDK generation, repository static checks and the final production build pass. Regenerating the SDK and OpenAPI produces no diff. The production private-HTTP smoke boots without page errors. Canonical verification finishes with `local-passed`; its machine-readable result is generated at `.artifacts/verify/report.json`.

Electron 42.5.0 passes the native page-pool, multi-page and import fixtures using an isolated user-data directory. The first attempt lacked the local executable; the retry uses a verified same-version binary. The full production test gives reconnect mutations their own Session fixture, so later navigation tests do not inherit changed text. Assertions target the active visible presentation and the floating latest control, retaining the original no-greeting and keyboard guarantees.

Failed experimental samples are excluded: an early fixture reused historical message IDs, an intermediate activity guard shadowed an accessor, and an initial integrity assertion mistook a virtualized Markdown window for the complete document. The final fixture uses disjoint IDs, checks both complete streams and preserves failed outputs outside the repository.

This synthetic benchmark does not reproduce the reported 30-second stall or establish a release 3.0.22 regression boundary. It demonstrates the change's behavior and work reduction under a fixed workload. Native fixtures exercise the current code, but the complete integrated Desktop application and native human menu interaction were not launched for this measurement. Complete package coverage and cross-platform CI remain separate evidence. Both benchmark Runtimes exit, and their listener is released. Runtime logs and local paths are excluded from this report.
