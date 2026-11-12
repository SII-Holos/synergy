# Decision Record: Drain retained Environment Uses before Session freeze

Status: implemented

## Problem

A Session can retain a native Environment admission after provider preparation completes without publishing an Execution record. Execution-only drainage allowed final epoch freezing while that original Use remained occupied.

## Decision

The Environment owner checks all pages of its existing canonical Use records. Original admission/preparation origins identify exact Session occupancy; the existing Execution owner returns provenance from its canonical receipt for retained operations. Unknown or unattributed Uses linked to the selected Environment or current Workspace block freezing. Native owner inspection rejects inconsistent Scope claims.

Known other Session and Host occupancy remains owned by those invocations. An accepted execution preparation already contains its verified original origin and does not require a not-yet-published Execution receipt merely to distinguish its owner. Inspection never cancels, releases, reassigns or imports Uses.

The epoch owner invokes the Use assertion inside its actual final publication transaction. Its existing native pending-request guard remains attached to the SQL driver's commit decision. No derived occupancy index, second fact table, stored schema or new execution authority is added.

## Alternatives considered

**Use only Execution discovery and pending requests.** The real retained admission had neither an Execution record nor an outstanding preparation request and was incorrectly considered drained.

**Require an entirely idle shared Environment.** Other known Sessions and Hosts can keep their independent Uses; a Task handoff cannot cancel or consume their work.

**Resolve unknown ownership by deleting or transferring the Use.** Unknown facts cannot prove physical termination. They remain retained for their original native owner to reconcile.

## Consequences

Freeze qualification streams active Use metadata without a lifetime item cap or a new index. The Session's original owner must release its occupancy before final freezing succeeds. This guard does not register the `session-environments` portability reader, copy provider credentials or allocation receipts, establish target mappings, or enable Continue.

## Verification

Harness `test/session/transfer-environments.test.ts` reproduces the original final-freeze acceptance, preserves Uses across refusal, checks a matching admission beyond a page of independent owners, rejects unknown and cross-Scope facts, and retains another Session's actual held preparation until its original signal cancels. Execution-origin, Use-ownership and aggregate-admission suites preserve native pending, migration, lost-acknowledgement and mutation behavior. See [the postmortem](../../../postmortem/0133-session-freeze-ignored-retained-environment-admission.md).
