# Decision Record: Preserve Digital Twin preferences in essential Scope snapshots

Status: implemented

## Problem

The composer and background predictor read automatic prediction from the Scope configuration populated by `scope.bootstrapCore()`. Its essential preference projection omitted `digitalTwin`, so an explicitly enabled setting returned by the configuration API became absent in the frontend store. Configuration refresh uses the same snapshot and could not restore it.

## Decision

Include `digitalTwin` in the existing essential preference selection. The lazy projection retains the registered owner's schema, including automatic prediction and optional model selection, without importing Digital Twin into Server. An unregistered owner stays absent. Initialization, reconnect and configuration refresh continue using the same generated SDK snapshot and existing store reconciliation.

The full-composition HTTP regression compares the configuration and essential snapshot for Home and project Scopes, covering missing settings, explicit disablement, enablement and a selected prediction model. The Server-only bootstrap regression retains the absence guarantee. Existing rendered composer tests remain responsible for completion-event triggering, manual prediction and automatic opt-in.

## Alternatives considered

**Fetch full configuration from each predictor.** This introduces another request and configuration lifetime instead of correcting the snapshot already consumed by both predictors.

**Return all configuration in the essential snapshot.** This restores unrelated provider and Agent configuration to the navigation path and defeats its deliberate preference-only projection.

**Enable automatic prediction when the field is missing.** This violates explicit opt-in and makes an absent optional capability or unset preference spend model calls.

## Consequences

Configured prediction preferences reach both existing consumers without a new API, store or inference path. The essential response grows only by the small registered settings object. OpenAPI and generated SDK types include the same optional field. Persisted settings, automatic-prediction defaults, completion deduplication and explicit submission remain unchanged.
