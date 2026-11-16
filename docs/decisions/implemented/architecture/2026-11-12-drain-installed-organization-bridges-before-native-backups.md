# Decision Record: Drain installed organization bridges before native backups

Status: implemented

## Problem

A Hosted Runtime had no selected native maintenance cohort. Even when callers selected generic Session owners manually, its live bridge could continue connection checkpoint and receipt work while the namespace was captured.

## Decision

The canonical organization Runtime composition registers an organization bridge maintenance owner after the Session and Cortex owners. Its drain awaits the actual bridge and handoff controller closure; inspection succeeds only after that closure succeeds. The selected Hosted cohort also requires the native Process, Workspace and Environment owners.

A confirmed ordinary backup release starts a new bridge through the original composition. Permanent retirement retains the Kernel hold, so it cannot use this release path. Availability metadata and a deployment incarnation do not establish native writer retirement.

## Alternatives considered

Requiring each backup caller to provide its own empty writer report would miss the installed bridge. Closing the bridge before Session drainage would interrupt accepted execution receipts. The composition retains one bridge owner and the existing maintenance ordering instead.

## Consequences

Normal backup may briefly disconnect the Runtime. Existing Session, actor and machine identity remain unchanged. This decision does not implement Hosted target reconstruction or authorize automatic Continue.

## Verification

`packages/organization-runtime/test/hosted-runtime.test.ts` uses the actual TLS service, enrolled Hosted Runtime, signed Session creation and heartbeat stream. Frozen maintenance disconnects its bridge; confirmed release reconnects with a higher connection epoch while retaining the Session creator. Permanent retirement requires its separate native fence owner.
