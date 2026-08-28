# Decision Record: doc-check treats the decision-record archive seal as structural

Status: implemented

## Problem

The document gate enforces one physical line per paragraph. Decision-record archiving ([Decision records](../../README.md)) mandates the exact opposite shape for metadata: `Status:` sits on line three and the `Archived: YYYY-MM-DD` line is inserted directly below it with no blank line between them. The first archived record (`archived/bug-fix/2026-08-22-tool-attachments-collapsible-card.md`) therefore failed `doc:check` with no compliant way out — sealed archive files are frozen by the manifest hash and can never be reflowed, and inserting a blank line would violate the record format the `decision:check` gate cross-checks. Two repo contracts collided and one gate had to lose.

## Decision

`script/doc-check.ts` classifies exactly one metadata shape as structural: the archive seal line `Archived: YYYY-MM-DD`, via a narrow `DECISION_META` pattern added to `isSpecialLine`. The seal alone is sufficient: wrap violations and reflow merging depend on the _next_ line being non-special prose, so exempting the seal automatically shields the `Status:` line directly above it, and `Status:` lines everywhere else (postmortems, ordinary records, wrapped prose that happens to end in `Status: implemented`) keep full one-physical-line enforcement. A unit test in `test/script/doc-check.test.ts` pins the archived shape, the wrapped-prose-into-`Status:` negative case, and the free-form `Status:` continuation case.

## Alternatives considered

**Exempt both `Status:` and `Archived:` lines (the first cut, flagged in PR review)** also silenced real violations: wrapped prose ending in an exact `Status: implemented` line became invisible to the gate, and existing postmortems already use that exact form, so the exemption leaked far beyond the archive contract; rejected in favor of the seal-only pattern.

**Reflow or separate the two metadata lines in the archived file** is impossible twice over: the archive seal freezes file content (any edit breaks the manifest sha256), and the decision-record format contract requires `Archived:` immediately below `Status:`; rejected.

**Blank line between `Status:` and `Archived:` in the record format** would appease the wrap rule but changes the format every existing record and `decision:check` follow, churning all records for a checker limitation; rejected.

**Scope the exemption by path or require `Status:`/`Archived:` adjacency** (the PR review suggestion) would also work but needs either path plumbing through `isSpecialLine` or two-line lookahead state in both wrap passes — more machinery for the same pixels as exempting the one line that is metadata in every document it appears in; rejected as unnecessary.

## Consequences

Archived records pass `doc:check` unchanged and the two gates (doc wrap discipline, decision-record format) no longer conflict. The exemption surface is one exact date-stamped line that prose never produces naturally, so the one-physical-line rule keeps its force everywhere else — including postmortem `Status:` lines and any future metadata conventions outside the archive seal. The cost is one special-case regex in the checker, guarded by a unit test that pins both directions so the exemption cannot silently widen.
