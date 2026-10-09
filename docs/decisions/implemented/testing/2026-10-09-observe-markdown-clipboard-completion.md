# Decision Record: Observe Markdown clipboard completion

Status: implemented

## Problem

A browser click dispatches an asynchronous Markdown copy handler; it does not await its clipboard writer. The public `ClipboardWriter` supports promises. Reading the last copied value immediately after a click therefore cannot establish the completed copy result for every supported writer. A synchronous fixture writer hides that missing readiness check. Virtual code slices also expose several copy buttons, so a completion observation must belong to the button actually clicked rather than whichever button a locator resolves later.

## Decision

The [virtual Markdown browser suite](../../../../packages/ui/test/markdown-virtual.browser.test.ts) holds a configured writer behind an explicit release barrier. It verifies that the writer has started without publishing a copy or success feedback, releases the barrier in `finally`, and waits for the clicked button's terminal feedback before asserting success and exact equality with the full original code. The trusted math copy waits for its successful tooltip before checking the exact LaTeX source. Existing document-size, DOM-bound and page-error assertions remain unchanged, as do the test and hook deadlines.

Failure diagnostics report copy count, UTF-16 and UTF-8 lengths, the first differing source position and excerpts, all code-button labels and states, and buffered browser navigation/console errors. The test verifies the selected button's label and rendered code context before clicking. Diagnostics print only on failure.

Fixture-local dependency caching, explicit optimization without runtime discovery, and entry warmup follow the [hermetic Vite fixture decision](2026-08-31-hermetic-vite-fixtures-for-playwright-dom-tests.md). The suite runs individually through the UI runner's existing isolated list in [test options](../../../../packages/ui/script/test-options.ts). These fixture changes do not alter Markdown or clipboard production behavior.

## Alternatives considered

**Poll until copied content equals the expected source.** Rejected: readiness and correctness would use the same predicate, turning an incorrect completed write into a timeout instead of a direct content failure. Button feedback provides an independent completion observation; byte-preserving equality remains the oracle.

**Retain only the synchronous writer.** Rejected: it cannot expose the interval between handler dispatch and completion that the public writer API permits. A controlled promise barrier proves the readiness requirement without sleeps or dependence on execution speed.

**Extend deadlines or retry the whole test.** Rejected: neither establishes handler completion or correct source ownership. The interaction and setup budgets remain bounded at their existing values.

## Consequences

The regression exercises a real worker-rendered virtual document and actual click handler with an isolated clipboard boundary, without accessing the operating-system clipboard. It adds a small deterministic barrier and completion observation rather than a production implementation change. Holding the writer produces the premature-read failure, and releasing it preserves the exact full-code and trusted-math assertions.

This proof establishes a test readiness gap, not the unique cause of an earlier CI mismatch: the original fixture writer recorded synchronously, and the earlier failure did not include copy count or differing bytes. Fixture startup reloads and asynchronous-writer readiness are separate observations; neither alone proves that the original failure was intermittent or that a product clipboard defect existed.
