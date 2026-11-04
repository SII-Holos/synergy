# Decision Record: Frontend memory residency lint

Status: implemented

## Problem

Frontend memory growth shows up as deep copies and full-transcript reads on admission and per-update paths. Review had no shared file list, and a memory postmortem could close with only prose guardrails. A repository-wide ban on `new` or `.map` would flag ordinary construction and projection.

## Decision

[Memory residency scope](../../../operations/memory-residency-scope.md) lists retain, boundary, and hot globs. `oxlintrc.json` applies `memory-residency/no-restricted-syntax` to the boundary and hot globs: `structuredClone()` on both, and `session.messages()` on boundary only. Retain has no lint selector. Oxlint has no native `eslint/no-restricted-syntax`, so [memory-residency.js](../../../../script/oxlint/memory-residency.js) applies those selector options. A memory-residency postmortem names one new or tightened machine check. Product runtime behavior is unchanged.

## Alternatives considered

- **Ban `new` and `.map` repository-wide.** Rejected because both are ordinary construction and projection, so the check would be noise outside admission and per-update files.
- **Wait for native `eslint/no-restricted-syntax`.** Rejected because current oxlint does not implement that rule. A local plugin keeps the selectors in `oxlintrc.json`.
- **Lint the retain tier now.** Rejected because retained stores already copy bounded windows, and a selector that matches those copies would force runtime edits.
- **Expand performance benchmarks or timeline markers.** Rejected because this change is the static file list, the admission lint, and the postmortem check.

## Consequences

Boundary and hot files fail lint on `structuredClone()`. Boundary files also fail lint on `session.messages()`. A legitimate copy needs a narrower glob or a different API. Retain files stay on the review list. Memory-residency postmortems cite a lint selector or a contract test name. The plugin runs only where the override enables the rule. The postmortem catalog already filled its 800-word ceiling, so that budget is now 840 to hold the machine-check line.
