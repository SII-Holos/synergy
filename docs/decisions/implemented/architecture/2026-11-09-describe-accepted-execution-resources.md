# Decision Record: Describe accepted execution resources before materialization

Status: implemented

## Problem

Native task materialization needs the selected model descriptor. Requiring a materialized root to read that descriptor creates a circular dependency; treating metadata access as root authority would instead permit calls before native execution evidence exists.

## Decision

The native command receiver can produce a finite resource-description proof from retained accepted task intake and current Session fences. The proof has its own signature domain and contains no materialized-root claim. Root binding continues to verify the canonical user message and Rollout record independently.

The service verifies the machine, reconciles the accepted receipt, then resolves current grant, driver, project role, selection and resource availability through the binding owner's shared authorization logic. Description returns the active grant and its exact ordered resource descriptors. Strict response validation excludes endpoints and credentials and verifies model/connection roles against the selection. The operation allocates no root index or call budget.

## Alternatives considered

**Bind a grant while describing resources.** A native Inbox receipt identifies the prospective message but does not prove materialization. Binding remains a separate evidence-bearing operation.

**Populate models from personal configuration.** This would bypass the organization resource selection and expose unrelated credentials or providers.

**Duplicate selection authorization in a new catalog owner.** Accepted work must preserve its established selection while checking current driver and resource authority. Sharing the grant resolver keeps those decisions consistent.

## Consequences

Metadata can be prepared for queued accepted work without activating execution. A later materialization failure leaves the grant provisional. Resource unavailability or authorization changes can block description after B has been reconciled; that failure does not undo reception or replay input. Reconnect uses the current machine proof while retaining the original receipt.

Protocol, service, native intake and generated HTTP integration tests cover description before a root exists, signature separation, secret exclusion, no allocation, unavailable resources, retained B, restart and current-role changes. Member provider preparation and execution activation remain separate integrations.
