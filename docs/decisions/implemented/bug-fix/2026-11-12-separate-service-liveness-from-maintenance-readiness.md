# Decision Record: Separate service liveness from maintenance readiness

Status: implemented

## Problem

The organization health route entered ordinary service admission. Frozen maintenance therefore returned a business error instead of its declared health response, and a process probe could not distinguish planned admission suspension from process failure.

## Decision

The service recognizes only exact GET and HEAD health paths before business admission. `/org/v1/live` reads process availability without storage. `/org/v1/ready` and the compatible `/org/v1/health` read current installed maintenance admission through a read-only snapshot, returning their declared health response with status 503 during a hold. Probes create no accepted-operation tail and cannot block drainage. The probe still passes through common HTTP origin and response-header middleware. All other requests retain ordinary admission.

The route catalog and direct service entry share the same response owner. Generated clients expose liveness and readiness independently. Closed service handles return unavailable without reentering a disposed context.

## Alternatives considered

**Use one admission-controlled probe for both checks.** Maintenance would trigger process replacement even when the service is healthy and deliberately preserving its original operation.

**Exempt every health-like URL from admission.** Exact read-only paths keep the exception from admitting mutations or business requests.

## Consequences

Operators can retain a live process during backup while routing fresh requests away. A real loopback HTTP fixture verifies maintenance, release, typed legacy health and HEAD responses alongside the existing service maintenance suite. See [the postmortem](../../../postmortem/0153-service-maintenance-obscured-health-probes.md).
