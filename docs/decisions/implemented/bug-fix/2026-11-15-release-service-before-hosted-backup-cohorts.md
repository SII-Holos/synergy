# Decision Record: Release Service maintenance before dependent Hosted backup participants

Status: implemented

## Problem

Cohort backup releases independent native holds after sealing its archive. A confirmed Hosted release starts its original bridge, so releasing it concurrently with the Service can open that bridge while Service admission remains held. If Service release fails, a dependent Hosted writer can still resume into a Service that refuses fresh work.

## Decision

The Cohort owner awaits the original Service release and reopening before attempting Hosted releases. Every call retains its original Runtime, primary Store and opaque lease checks. A failed Service release leaves dependent Hosted holds in their actual phases; an earlier incomplete capture can leave draining or frozen participants. This adds no synthetic release result or automatic recovery.

Once Service release succeeds, independent Hosted releases retain their parallel settlement and error aggregation. An existing capture error remains first, followed by actual release failures in participant order. Unattempted Hosted releases contribute no invented errors. The original aggregate remains a failure even if an encrypted archive was already sealed.

Explicit recovery in the same live Runtime uses its original opaque leases through the same native release owners, with Service reopening first. A cold Runtime must use its separate reconciliation owner and cannot reuse those leases. Authentication, maintenance admission, heartbeat validation, deadlines and retry policy remain unchanged. See [Service maintenance](../architecture/2026-11-12-drain-organization-service-before-cohort-capture.md) and [Hosted bridge release](../architecture/2026-11-12-drain-installed-organization-bridges-before-native-backups.md).

## Alternatives considered

**Release every namespace concurrently.** Native storage independence does not remove the Hosted bridge's dependency on Service admission. A failed prerequisite must preserve the dependent hold.

**Permit heartbeats through a held Service or retry rejected bridges.** This changes authentication or maintenance behavior instead of respecting the original release dependency.

## Consequences

Hosted release waits for the actual Service reopen. If that fails, native holds and original errors remain available for explicit recovery; no dependent participant is reported released. This corrects release ordering without establishing the cause of a separate task-release observation failure. The [postmortem](../../../postmortem/0214-cohort-release-reopened-hosted-before-service.md) records the controlled reproduction and its verification limits.
