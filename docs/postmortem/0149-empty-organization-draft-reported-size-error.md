# Empty organization draft reported a size error

## Executive summary

A newly opened organization conversation showed the oversized-input warning with an empty message field. Send was correctly disabled, but the composer mislabeled the schema's empty-text rejection as a size failure. The size warning now applies only to nonempty text, preserving the existing oversized-draft guard.

## Summary

Combined full-App acceptance exposed an alert before the user entered a message. The command schema requires a nonempty text part and also enforces supported size limits. The UI used the failure of that entire schema as its size predicate, so an ordinary blank draft appeared invalid for the wrong reason.

## Timeline

1. The current captured full-App fixture rendered an empty organization composer with the existing size warning. This observation was separate from fixture bootstrap corrections and responsive selector assumptions.
2. A fresh isolated browser loaded the unchanged captured bundle and actual organization conversation route. It verified an empty field and counted one size alert; the assertion requiring zero failed.
3. The composer retained the canonical input schema and existing Send conditions, adding a nonempty-text condition to its size predicate.
4. The permanent combined browser test checks empty-input silence with disabled Send and a retained oversized-text positive control. Three-space restoration, original notification/decision targets, identity retirement and unknown input reconciliation remain separate assertions in the same full-App recipe.

## Root cause

A schema validation failure was used as a specific size diagnosis. Empty input is an ordinary editing state whose unavailable Send action already explains its behavior. It does not establish that the draft exceeds any limit.

## Guardrails

- [x] Machine check: `apps/web/test/context/space-combined.browser.test.ts` asserts that an empty message has disabled Send and no size warning.
- [x] Machine check: the same case retains oversized text, shows the existing warning and keeps Send disabled.
- [x] Owning decision: [empty organization input](../decisions/implemented/bug-fix/2026-11-12-avoid-size-errors-for-empty-organization-input.md) preserves backend input semantics and the original draft owner.

## Lessons

Distinguish an ordinary incomplete editing state from the specific invalid condition named by an error. Preserve the real size guard and retained draft rather than weakening the command schema to silence a misleading message.
