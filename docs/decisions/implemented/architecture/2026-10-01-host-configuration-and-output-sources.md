# Decision Record: Keep embedded configuration and output storage with their host

Status: implemented

## Problem

An embedded runtime needs an authoritative configuration and a model-readable output destination. Loading user configuration or saving tool output inside its private data directory can violate that ownership even when the host supplies an exclusive provider inventory.

## Decision

The output-provider portion of this decision is superseded by [the bounded extension decision](2026-10-05-bound-embedded-host-extension-surface.md). Its registration API is removed; the configuration source remains active. The original output-provider decision below records its rationale.

Register a Runtime-scoped ConfigSource before composition seals. Its schema-validated JSON snapshot replaces file, inline, remote and experiment configuration reads. Host-owned configuration is read-only through Config's mutation APIs; source errors do not select a last-good fallback. Register ToolOutputSource to save complete tool output and return its model-readable reference, with optional exact tool origin. Truncate retains one algorithm and the default native file behavior when no source is selected.

Runtime composition selects the configuration migration authority before registration seals. An exclusive ConfigSource leaves local configuration file migrations unregistered and unstamped; a file-backed Runtime can still apply them later. The provider credential migration retains its original domain and receipt because configuration ownership does not imply credential ownership.

## Alternatives considered

**Private configuration files.** They add a second configuration authority and preserve implicit discovery of scripts and tool definitions.

**A host copy of truncation.** It forks limits and hints and requires hosts to track core algorithm changes.

## Consequences

Default product behavior remains unchanged. Hosts own snapshot availability and output durability, and must reject unavailable storage. Public source tests cover isolation, sealed composition, activation validation, failure propagation, exact output bytes and tool origin; existing truncation tests retain native coverage.
