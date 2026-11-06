# Decision Record: Host provider request preparation

Status: implemented

## Problem

A host-authoritative model catalog describes stable inventory. Credentials and authorization context can belong to one accepted user invocation and expire between requests. Putting them in the catalog shares mutable authorization across concurrent Sessions; reimplementing provider preparation duplicates core model and timeout behavior.

## Decision

One optional Runtime-owned ProviderRequestSource prepares ephemeral connection credentials, headers and JSON SDK context from a detached root user message, Session and model before worker handoff. The source is sealed with composition. Cancellation and source or serialization errors prevent preparation. The resulting connection changes only the worker plan, after model parameters and prompt transforms have been assembled. It is not stored in the catalog or recorded as model parameters.

## Alternatives considered

Catalog key mutation races concurrent invocations. A plugin parameter hook puts credentials into model-visible parameters and does not provide a stable host authorization boundary. A separate model loop duplicates core behavior.

## Consequences

Hosts validate the invocation and supply an explicit SDK factory that consumes the optional hostRequest context. Default product runtimes retain their unchanged plans. Tests cover real LLM preparation, worker-plan serialization, invocation independence, detached source input, catalog isolation, cancellation, failure, Runtime isolation and rejected non-JSON context.
