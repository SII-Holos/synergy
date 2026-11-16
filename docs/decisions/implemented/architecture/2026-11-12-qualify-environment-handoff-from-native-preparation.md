# Decision Record: Qualify Environment handoff from native preparation

Status: implemented

## Problem

The native Environment portability owner drains selected Uses and seals operation history before the organization source controller captures files. The controller still rejected every selected Environment, so a supported native selection could not reach target preparation despite having its required proof.

## Decision

The Environment portability owner exposes `assertPreparedSource` for the exact draining or frozen source binding. It requires the original source intent, sealed Environment record, canonical Session selection, actual native binding, matching provider descriptor and generation, complete operation count and drained Uses. The check only reads existing evidence; it cannot create a seal, drain an unknown writer or allocate a destination. Export uses the same qualification before producing the Environment closure.

The organization source controller requires reader-two compatibility and this native qualification for each selected Environment in the aggregate. Missing owners retain the structured transfer requirement. Missing or changed preparation evidence fails before the source can claim a final frozen aggregate. Target mapping continues to require the destination owner's compatible explicit selection and atomic paused publication.

## Alternatives considered

**Remove the selected-Environment guard.** Registration or an Environment ID does not prove that its current Uses, descriptor and completed history belong to this handoff.

**Keep rejecting all selections.** This prevents an already implemented native portability owner from participating in the real organization controller chain.

## Consequences

The generated HTTPS handoff fixture now transfers a selected dormant native Environment between actual enrolled member and hosted Homes. The target retains its explicit local Environment mapping, stays paused and allocates no compute or replayed input. The existing completed native-operation fixture qualifies both draining and frozen states and rejects missing or changed source seals. Cloud Environment mappings, compute and complete Workspace handoff remain separate required work.
