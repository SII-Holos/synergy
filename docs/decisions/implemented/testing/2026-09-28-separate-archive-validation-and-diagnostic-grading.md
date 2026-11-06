# Decision Record: Separate archive validation and diagnostic grading

Status: implemented

## Problem

Sharing one export deadline with archive inspection can kill verification after a successful ZIP export. Synthetic missing-result entries and changed test numbering can then be mistaken for executed assertions. The Doom task can accept an old frame as evidence from a new VM launch. Prepared-source receipts and byte inventories may list the same paths in different deterministic orders; treating list position as content caused a false source-change failure before a model request.

## Decision

The benchmark assigns ZIP export and validation separate bounded periods, each 300 seconds by default. A timed-out validation can be resumed only against the same retained ZIP whose hash and size match the original evidence, using the original run's frozen verifier and dependency map; the recovery writes a separate receipt and makes no model call. CTRF reconciliation reports actual failures, missing outcomes and uniquely matched numbered JUnit cases separately without changing native reward. A version-locked Doom diagnostic task removes the stale frame before startup and shares one captured VM launch across text and image assertions. The original task and historical scores remain immutable. Source inventory verification checks the sealed receipt digest, then compares entries canonically by path; differing enumeration order alone does not invalidate unchanged source bytes.

## Alternatives considered

**Increase the shared export deadline:** A larger shared window still permits export to consume nearly all validation time and does not identify which phase failed.

**Re-export or rerun the agent after validation timeout:** Either creates new evidence under different conditions and risks replacing the original observation. Validation recovery uses the retained archive only.

**Rewrite historical rewards after diagnostic checks:** A later verifier or task source is a different condition. Diagnostic outcomes remain separate from native historical scores.

## Consequences

JUnit execution counts use recorded, non-skipped cases instead of declared suite totals. Numbering reconciliation preserves skipped outcomes and cannot label them as passes or evidence of execution.

Recovery exports retain the original plan's archive-validation budget independently of the requested export budget. The outer container deadline includes both stages and cleanup headroom, so it cannot cancel validation merely because export consumed its own allocation.

Validation can finish after a slow but successful export, with independent stage timing and a retained ZIP if validation times out. Recovery refuses changed archives or an unverified prepared product bundle. Test reports can identify numbering drift and timeout placeholders without counting them as assertion failures. The Doom diagnostic changes the task digest and must be declared as a separate diagnostic condition in comparisons.
