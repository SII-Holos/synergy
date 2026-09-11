# Decision Record: Package bug reports through a review-ready drafting skill

Status: implemented

## Problem

Synergy bug reports today are hand-written: the diagnosing agent produces a root-cause analysis in conversation, and the user separately composes a GitHub issue from it. The history of bug investigations in this repository shows strong diagnostic practice but no shared packaging standard — drafts vary in structure, evidence claims are not consistently separated from inference, and redaction discipline for outbound text is re-derived each time. When a diagnosis session hands off to an issue, session context (reproduction commands, log windows, failure shapes) is often lost or pasted unredacted. [Issue #557](https://github.com/SII-Holos/synergy/issues/557) proposes a full Bug Reporter agent with a diagnostics tool, a publication redaction pass, durable drafts, and a gesture-gated publish route — a large multi-surface feature whose first delivery step is explicitly a copyable Markdown draft.

## Decision

Add a repository Skill, `report-bug`, that packages a diagnosed or observed problem into a review-ready issue draft. The skill is the first delivery step of #557, scoped to documentation only:

- A complete issue-body template aligned with [.github/ISSUE_TEMPLATE/bug_report.yml](../../../../.github/ISSUE_TEMPLATE/bug_report.yml), extended with `Diagnostic findings` split into `Observed` / `Inferred` / `Unknown` and a `Reproducibility` statement.
- Evidence rules distilled from postmortems and past investigations: lead with the deepest confirmed origin, keep every claim attributable to a cited evidence source, and confine unverified material to `Unknown`. Calibration guidance distinguishes "data disappeared" failures (possibly real regressions) from "an extra thing appeared" failures (usually cross-file test-state leakage) and states what a CI-only failure report must record.
- A boundary rule: diagnosis owns `/debug` with `find-logs`, `inspect-sessions`, and `architecture`; this skill packages findings and never opens an issue itself — the user reviews the full text and files it. Redaction defers to the shared outbound-text rule in `git-guide`.
- Registration in the routing surfaces: root `AGENTS.md` Repository Skills list, the `docs/reference/development.md` workflow-ownership table, the `llms.txt` skill index, and `/debug` step 8, which hands off to the skill when the user wants the problem reported upstream.

## Alternatives considered

- **Extend `/debug` to end in an issue draft** — rejected: it couples root-cause diagnosis with report packaging in one command, and a command is a narrower trigger surface than a skill the user can invoke directly; the handoff now stays an explicit step that references the skill.
- **Extend `find-logs`' Package and Report section** — rejected: reporting would become a subordinate capability of log tooling, hiding the workflow from the common "file a bug" phrasing that does not involve logs at all.
- **Implement #557's `report_diagnostics` tool and redaction pass now** — deferred: that is a large surface (first-party tool registration, publication-specific sanitization, agent-visibility decision) and the maintainer question of how the flow ships is still open. The skill validates the draft contract and evidence discipline first; the template and redaction checklist can later seed the tool's output schema and sanitization tests without rework.
- **No change** — rejected: it leaves issue quality and redaction to per-session improvisation and loses the diagnosed context at handoff.

## Consequences

Enforcement is prompt-level, not code-level: the skill disciplines drafting but nothing mechanically blocks an unredacted claim, so the user-review step remains the real boundary and the skill deliberately does not automate publication. The template is a superset of the GitHub form — drafters may need to trim optional sections, which the skill instructs rather than enforces. Documentation surfaces gained one more entry to keep in sync when skills change (`AGENTS.md`, `development.md`, `llms.txt`, `/debug`). The path to #557 stays open: the draft format, evidence triad, and redaction checklist are written to be directly reusable as the future diagnostics tool's output contract and the publication sanitization pass's test cases.
