# Postmortems

Incident write-ups: a bug reached a place it should not have (a real user, a merged PR, or a release), and the interesting part is _why our process let it through_, not just the one-line fix.

A postmortem is a backward-looking record of a failure: what broke, the mechanism, why every safety net missed it, and the concrete guardrails added so the same class of bug fails loudly next time.

## When to write one

Write a postmortem only when **all three** criteria hold:

- **Subtle** — the mechanism is non-obvious, and a careful engineer would re-derive it the hard way.
- **Systemic** — the bug escaped because of a gap in tests, tooling, or conventions, not a one-off typo.
- **Costly to rediscover** — it cost real debugging time, and it would cost it again.

A bug that fails any of these criteria is a bug fix with tests, not a postmortem.

## Placement

- Bugs and the process failures that let them escape belong in postmortems (this directory).
- Deliberate decisions, their rejected alternatives, and rationale belong in decision records at `docs/decisions/`.

## Format

Each postmortem is a file named `NNNN-kebab-case-title.md`, numbered sequentially; the first future entry is `0001`. Use these sections:

- **Executive summary** — one short paragraph a busy reader can absorb in thirty seconds: what broke, the root cause in plain terms, why it escaped, and the durable lesson.
- **Summary** — the full detail of the failure.
- **Timeline** — what was observed and when.
- **Root cause** — the mechanism, and why every safety net missed it.
- **Guardrails added** — the concrete fixes, linked: tests, doc updates, gate changes.
- **Lessons** — the durable takeaways.

## Index

Entries are added only when an incident qualifies; the table stays empty until then.

| Number | Title                                                            | Status      | Date       |
| ------ | ---------------------------------------------------------------- | ----------- | ---------- |
| 0001   | Coverage-mode test run wrote fixtures into the real Synergy home | implemented | 2026-08-18 |
| 0002   | ToolScheduler singleton leaked across CI shard-process tests     | implemented | 2026-08-20 |

## History rules

Postmortems are current-history documents: they record what actually happened, they are never edited to hide mistakes, and guardrails that later become obsolete stay recorded as lessons.
