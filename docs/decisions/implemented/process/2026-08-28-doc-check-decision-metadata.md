# Decision Record: doc-check treats decision-record metadata lines as structural

Status: implemented

## Problem

The document gate enforces one physical line per paragraph. Decision-record archiving ([Decision records](../../README.md)) mandates the exact opposite shape for metadata: `Status:` sits on line three and the `Archived: YYYY-MM-DD` line is inserted directly below it with no blank line between them. The first archived record (`archived/bug-fix/2026-08-22-tool-attachments-collapsible-card.md`) therefore failed `doc:check` with no compliant way out — sealed archive files are frozen by the manifest hash and can never be reflowed, and inserting a blank line would violate the record format the `decision:check` gate cross-checks. Two repo contracts collided and one gate had to lose.

## Decision

`script/doc-check.ts` classifies decision-record metadata lines as structural: a narrow `DECISION_META` pattern — `Status: implemented`, `Status: proposed`, `Status: rejected …`, and `Archived: YYYY-MM-DD` — is added to `isSpecialLine`, exempting those lines from both wrap merging (`reflowMarkdown`) and wrap violations (`findWrapViolations`). The pattern is deliberately exact-match: a prose line like `Status: some free-form prose` still reports a violation, pinned by a unit test in `test/script/doc-check.test.ts`.

## Alternatives considered

**Reflow or separate the two metadata lines in the archived file** is impossible twice over: the archive seal freezes file content (any edit breaks the manifest sha256), and the decision-record format contract requires `Archived:` immediately below `Status:`; rejected.

**Blank line between `Status:` and `Archived:` in the record format** would appease the wrap rule but changes the format every existing record and `decision:check` follow, churning all records for a checker limitation; rejected.

**Exempt any leading `Word: value` line** would also swallow genuine prose paragraphs that begin with a colon-suffixed word, weakening the one-line-per-paragraph rule repo-wide; rejected in favor of the exact two-field pattern.

## Consequences

The first and all future archival records pass `doc:check` unchanged, and the two gates (doc wrap discipline, decision-record format) no longer conflict. The cost is one more special-case regex in the checker, guarded by a unit test that also pins the negative case so the exemption cannot silently widen. Archived records stay byte-frozen and the wrap rule keeps its force everywhere else.
