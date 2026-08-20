# Decision Record: Align staged doc-check scope with the full document scope

Status: implemented

## Problem

The pre-commit hook ran `doc-check --staged`, which checked every staged Markdown file for the one-physical-line paragraph rule. The full `doc:check` gate only checks the engineering document scope (README, CONTRIBUTING, AGENTS, `docs/`, `.synergy/skill`, package AGENTS files). Files outside that scope — such as `packages/app/PRODUCT.md`, which deliberately keeps one principle per line — were never subject to the wrap rule, so any PR touching them failed the hook on pre-existing lines even when the edit itself was correct.

## Decision

`script/doc-check.ts` now computes the canonical document scope once and, in staged mode, restricts the staged Markdown files to that same scope before running link and wrap checks. The new pure helper `filterStagedFiles(staged, scope, root)` resolves staged paths against the repository root (git prints staged paths relative to the root regardless of the invoking directory; resolving against the cwd would silently drop every file when the hook runs from a subdirectory). When staged markdown exists but every file is outside the scope, the run reports a warning instead of passing silently. Unit coverage lives in `test/script/doc-check.test.ts`.

## Alternatives considered

- **Rewrap `PRODUCT.md` to one-physical-line paragraphs** — rejected: the product document intentionally uses one-principle-per-line formatting for reviewability, and a mechanical reflow would churn hundreds of lines and collapse every principle into one paragraph.
- **Bypassing the pre-commit hook for this change** — rejected: hooks exist to keep gates honest, and the underlying inconsistency would keep blocking the next PR that touches out-of-scope Markdown.
- **Checking the wrap rule for every Markdown file in the repository** — rejected: it would impose the engineering-document format on product and other prose that deliberately follows a different layout, and would require a separate reflow policy.

## Consequences

- Pre-commit and `doc:check` now agree on which Markdown files must satisfy the paragraph-wrap contract.
- Files outside the engineering document scope keep their own formatting conventions; in staged mode they are now excluded from link checks as well as wrap checks (previously staged mode checked links on every staged Markdown file).
- The gate fix is small, tested, and does not change the full `doc:check` behavior or its budgets/generator freshness checks.
