# Decision Record: Attribute frontend behavioral coverage

Status: implemented

## Problem

The coverage gate requires a source record for every non-exempt runtime file. Vite fixtures and Chromium Workers execute transformed code outside Bun, so passing browser suites do not produce source LCOV entries. Treating these files as ordinary unit-tested modules hides the distinction between missing tests and missing instrumentation.

## Decision

Directly testable behavior remains instrumented. Shared UI source-render tests transform TSX with the established Solid Babel configuration inside an isolated, browser-conditioned Bun process and a fresh JSDOM. They exercise structured-result pagination and expansion, reactive replacements, user Markdown references, safe image placeholders, table enhancement and asynchronous cancellation. Welcome experience memory is tested directly across snapshot replacement and independent instances.

Web organization source-render tests reuse the Solid Babel loader with inline source maps and compile the real Lingui catalogs through the configured formatter. A single source-test inventory selects isolated browser-conditioned workers and bypasses only the legacy MessagePart mock; the rendered tree keeps the real Space, generated client, locale and UI renderer. Controlled transport or persistence ports do not replace authorization, view identity or disposal. Existing Chromium suites retain geometry, keyboard, reload and platform acceptance.

Exact-file coverage exclusions identify the real behavioral suite for layout, native selection, Canvas, lazy Office readers, module Workers and the remaining Vite-only wrappers. The session recovery browser fixture mounts the submission preview and verifies that its original draft and retry action survive a failed handoff. Pure rules, parsers, fixed-step timing, selection and upload state remain measured.

The tool-expansion context wrapper is attributed to [the tool lifecycle fixture](../../../../packages/ui/test/components/basic-tool-lifecycle.dom.test.ts), which opens a real tool, unmounts its virtual row and verifies that remounting retains the expanded content. Its exact source entry identifies Vite compilation as the instrumentation boundary; the package coverage floors and missing-record checks stay unchanged.

## Alternatives considered

**Exclude whole frontend directories.** This would conceal new, directly testable logic and provides no evidence for individual files.

**Lower thresholds or accept missing records.** This weakens the gate without resolving source ownership.

**Import-only probes.** These produce records without proving behavior or detecting a regression.

## Consequences

Coverage floors and missing-source enforcement stay unchanged. Browser instrumentation boundaries are explicit and reviewable, while new source-render tests contribute original TSX records to LCOV. The small shared test loader needs browser-conditioned isolation; real-browser suites retain ownership of geometry and platform behavior that a DOM emulator cannot validate.
