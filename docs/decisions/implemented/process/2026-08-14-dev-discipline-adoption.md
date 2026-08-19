# Decision Record: Adopt dsh-style dev-discipline gates

Status: implemented

## Problem

Synergy's conventions relied on habit: docs could accumulate dead links and bloat, CI had no aggregate verdict, coverage had no gate, and reference docs drifted from source.

## Decision

Adopt, adapted from the dsh repo: a gated decision-record system (`docs/decisions/`, format gate `decision:check`), doc gates (md-links / md-wrap / doc-budgets) plus generated CLI/config/tool catalogs with freshness checks, an `all-checks-passed` CI aggregate job, per-package coverage thresholds with reasoned exemptions, a pre-commit fast-check layer, and a docs tier table (`docs/AGENTS.md`). Also adopt the `find-simplifications` survey workflow (from dsh's `dsh-find-simplifications`): it turns broad "find things to simplify" requests into evidence-backed simplification decision records, inline cleanup comments, and superseded-record coalescing.

## Alternatives considered

- **dsh bilingual triplet docs (`.i18n.yaml` blob-hash pairing + merge driver)** — rejected: the ~60k-word corpus translation and bilingual-review obligation do not match a single-language repo.
- **Per-file 100% coverage** — rejected: the existing test inventory is far from 100% and reaching it in one change would force mass exemptions that defeat the gate.
- **Issue/PR policy automation (policy.mjs, GitHub App token, Project V2)** — rejected: it depends on platform configuration outside the repo and is GitHub-management flow rather than in-repo discipline.

## Consequences

Every non-trivial change now carries a record; gates fail the build on format drift; generated reference docs cannot drift from source; coverage has a floor with an auditable exemption list.
