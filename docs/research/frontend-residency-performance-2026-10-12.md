# Frontend residency and projection measurements

This reference records the local production-browser experiment for [bounded residency and projections](../decisions/implemented/architecture/2026-10-12-frontend-residency-projections.md). Implementation invariants belong to [frontend data synchronization](../architecture/frontend-data-sync.md); the reproducible fixture and commands are in the [benchmark reference](../../apps/web/test/performance/README.md).

## Scope and method

The baseline is commit `41ca2852fc2d6e87db72a5d8bd63ccb8e8847d9f`, before this task's changes. It is not a measurement of release 3.0.22. Both builds use the same lockfile, Bun 1.4.2, fixture runner and synthetic input. The frozen baseline and candidate run sequentially, each with one isolated Runtime serving its built Web UI and a fresh temporary Home. The user's running instance is excluded.

The device is an Apple M5 Pro on macOS Darwin 25.6.0 arm64, using Playwright Chromium 149.0.7827.55 at 1728 × 1080 without CPU throttling. The workload contains three Scopes, twelve primary Sessions, 1,056 historical messages including one 550-message history, one turn with 2,001 tool Parts, two child Sessions, Notes, a large Markdown file and two simultaneous 300-chunk text streams. No model provider is invoked.

Each run warms three cross-Scope targets before thirty switches. Readiness requires visible target text. Request counters exclude warm-up; streaming bytes exclude navigation. Timing is a device observation. Shared CI checks deterministic bytes, requests, ordering and lifetimes rather than a machine-speed assertion.

## Results

| Measurement                      |  Baseline | Candidate |
| -------------------------------- | --------: | --------: |
| Stable streaming WebSocket bytes | 4,736,207 |   398,169 |
| Warm-switch Part body requests   |       189 |         0 |
| Warm-switch timeline requests    |        30 |         0 |
| Warm-switch readable P95         |   72.9 ms |   44.1 ms |
| Browser errors                   |         0 |         0 |

Stable streaming traffic falls 91.59%, exceeding the 80% target. In the baseline, thirty execution updates account for 3,698,738 bytes, approximately 78% of all streaming traffic. The final candidate also performs zero body requests throughout streaming, including terminal version checkpoints. It verifies every chunk from both streams in order, including the stream generated while its Session was inactive. Markdown validation scrolls rendered windows rather than assuming all document text resides in the DOM.

The production panel run holds the initial timeline response while the composer remains editable and workspace navigation opens. Notes retain their editor node and edits across Session switches. Files retain their reader node and a 350-pixel scroll position. Execution records retain their panel and search filter. Closing the real WebSocket while Notes are hidden causes zero hidden Note GET requests; reconnection preserves the editor on return.

Three rounds across all twelve Sessions retain six Session presentations. Evicted Sessions release their panels. Forced-GC heaps are 80,369,180, 66,598,868 and 67,217,364 bytes, showing a plateau rather than continuous growth. Behavioral panel tests separately open twenty resources and require the global eight-panel limit, retained selection and generation invalidation.

## Red and green evidence

| Invariant                                         | Observed failure before correction                                       | Verification                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Hidden virtual windows preserve reading position  | Late hidden scroll receipts replaced rows 150–159 with rows 0–5          | Real Virtua browser fixture retains the window and scrollTop 6000                                                              |
| Hidden layout work pauses                         | Prompt dock observer published height zero after deactivation            | Dock lifecycle and automatic-scroll tests preserve measurements                                                                |
| Retained panel state does not self-trigger writes | Restored Notes caused repeated tab updates and a reactive stack overflow | Workbench provider tests require one meaningful write; production Notes round trip succeeds                                    |
| Plugin registry refresh preserves accepted owners | Transient registry gaps invalidated retained views                       | Scope-generation and panel lifetime tests retain the same owner and evict changed generations                                  |
| Reconnect avoids hidden resource reloads          | Hidden Notes performed body and metadata reads after a socket close      | Production reconnect observes zero hidden Note GETs                                                                            |
| Oversized checkpoints remain readable             | A body larger than the memory budget evicted itself                      | Immutable, Scope-fenced checkpoint tests cover spooling, concurrent release and bounded handles                                |
| New projection removes repeated append work       | Compatibility checkpoints repeatedly transmit accumulated text           | Deterministic 300-append comparison requires at least 80% fewer bytes                                                          |
| Final checkpoints reuse complete streamed bodies  | The terminal checkpoint requested the entire body again                  | Version anchors preserve split surrogate pairs, metadata and canonical versions; equal-length edits still recover full content |
| Detail activation shares work                     | Explicit opening and visibility restoration started two requests         | One pending read survives activation; hiding aborts it and rejects its late response                                           |

Additional tests cover real multi-client WebSockets and released leases, independent detail revisions, cursor/epoch recovery, queue count/time budgets, late owners, deleted messages, and reconnect validation of 242 Parts in four disjoint loaded ranges. Obsolete whole-area-hidden and cloned-transition expectations were replaced with local-loading assertions while preserving owner, scroll and late-response protections.

## Verification and limitations

Fresh complete Web coverage passes with 3,562 passing tests, five skips and no failures across 128 runner groups. Line coverage is 65.5% against the unchanged 60% floor; function coverage is 83.7% against 50%. All 487 measured source files have coverage records. Five new exact browser-only source exemptions identify their real Chromium fixtures; coverage thresholds are unchanged.

All 33 workspace type checks, lint, SDK generation and the final production build pass. Canonical selected verification covers 54 behavioral test files, repository static checks, the browser crypto contract and the production private-HTTP smoke. Its machine-readable result is generated at `.artifacts/verify/report.json`.

Full-suite failures uncovered stale fixture wiring for owner-bound routing, capability/replay contracts and active detail leases. Updating those fixtures preserves their behavioral assertions. A separate detail activation test exposed a real duplicate-read race; the implementation now shares the pending read and aborts it when hidden.

Failed experimental samples are excluded: an early fixture reused historical message IDs, an intermediate activity guard shadowed an accessor, and an initial integrity assertion mistook a virtualized Markdown window for the complete document. The final fixture uses disjoint IDs, checks both complete streams and preserves failed outputs outside the repository.

This synthetic benchmark does not reproduce the reported 30-second stall or establish a release 3.0.22 regression boundary. It demonstrates the change's behavior and work reduction under a fixed workload. Electron and native Desktop presentation were not launched; native attachment ordering has browser lifecycle coverage. Complete cross-platform CI remains separate evidence. Runtime logs and local paths are excluded from this report.
