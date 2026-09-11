---
name: report-bug
description: Draft a redacted, review-ready GitHub bug report for Synergy from an already-diagnosed or observed problem, aligned with the repository bug template. Use after a root cause is identified or a reproducible symptom is confirmed, when the user asks to file, draft, or report a bug, or when a diagnosis session needs to hand off an issue draft. Not for the diagnosis itself.
---

# Draft a Synergy Bug Report

## Own the Boundary

Reporting and diagnosing are different jobs. `/debug` plus `find-logs`, `inspect-sessions`, and `architecture` own the root-cause work; this skill packages an existing finding into an issue draft for the user to review. Do not open a GitHub issue yourself and do not treat a draft as authorization to publish — the user reviews the full text and files it. Redaction is enforced by the shared outbound-text rule in `git-guide`: no absolute paths, `SYNERGY_HOME` values, session or Scope IDs, raw logs or traces, credentials, provider endpoints, or internal identifiers. Project-relative source paths are allowed.

Verify the underlying claim before drafting. A report built on an unverified hypothesis wastes maintainer time; rerun the failing command or test and cite its current behavior. If verification is impossible right now, say so in the draft instead of writing an unqualified claim.

## Draft From the Template

Produce the complete issue body in fenced Markdown for one-shot copying. It must answer every field the repository bug form asks for — what happened, expected behavior, reproduction steps, environment, and supporting evidence — as structured by [.github/ISSUE_TEMPLATE/bug_report.yml](../../../.github/ISSUE_TEMPLATE/bug_report.yml), and split the diagnostic evidence into observed, inferred, and unknown. Every section below is required except the last two, which should be dropped when empty rather than padded:

```markdown
## Summary

<One paragraph: what is broken, where it lives, and the confirmed root cause or current best-supported theory.>

## User-visible behavior

<What a user observes, as facts separate from interpretation.>

## Steps to reproduce

<Minimal numbered steps. Name the runtime (installed release or `bun dev` mode) and whether the failure is deterministic.>

## Expected behavior

<The invariant the violated behavior breaks, not just the symptom's absence.>

## Actual behavior

<The observed failure, including the exact error text or minimal stack frames.>

## Diagnostic findings

### Observed

<Evidence verified at runtime: failing test name and result, log or observability excerpt with timestamps trimmed, reproduction command. Cite the evidence source and time window.>

### Inferred

<Causal chain from the evidence, stated as theory with its supporting observation.>

### Unknown

<What the current evidence cannot establish. Unverified claims and unrecovered details belong here, not in Observed.>

## Environment

- OS:
- Synergy version: (`synergy --version` or dev branch/commit)
- Bun version: (`bun --version`)

## Reproducibility

<deterministic / intermittent (approximate rate) / not reproduced — with one sentence on what varies.>

## Additional context

<Linked issues, prior postmortems, regression window, or proposed fix — only when real.>
```

Apply these rules to the evidence sections. Lead with the deepest confirmed origin; contributing factors follow as consequences, not as co-equal layers. Keep every claim attributable to an evidence source; if a statement would not survive a maintainer asking "how do you know", it moves to Unknown. Never paste raw session transcripts, full tool inputs, or file contents; summarize them with redaction. Do not include internal session, Scope, trace, span, or call identifiers — describe the window in relative terms such as "for the six minutes before the circuit opened".

## Proportion the Investigation

A draft for a diagnosed bug needs only verification and packaging. When the user asks to report a bug nobody has diagnosed yet, gather the minimum evidence the template requires before drafting — the `find-logs` workflow produces most of it — and leave the rest as explicit Unknown sections instead of running a full root-cause investigation unasked. Do not let draft-polishing substitute for evidence: one reproduction command cited in Observed outweighs any amount of speculative detail.

Calibrate with known failure shapes. "Data disappeared" failures (a value became `undefined`, a count dropped, a fixture went missing) may be real regressions and deserve priority; "an extra thing appeared" failures (one more cache entry, one more registered client, one more retained node) are usually cross-file test-state leakage — check whether the suite passes when run alone before writing either kind up. For CI-only failures, record which job, shard, and platform failed and whether a rerun of the same commit reproduced it; a green rerun alone does not retire a failure.

Write the title as a symptom in the affected surface, not an internal file name — the root cause goes in the Summary, the user-facing effect goes in the title.

## Verify the Draft

Before handing the draft to the user, check it mechanically:

1. Every template section is present (Additional context only when non-empty).
2. Every claim in Observed cites its evidence source; nothing unverified sits outside Unknown.
3. No credentials, absolute paths, `SYNERGY_HOME` values, session/Scope/trace/span/call IDs, or raw transcripts.
4. Reproduction steps name the runtime mode and deterministic-or-not.
5. The draft file or message contains the complete body the user can copy without edits.
