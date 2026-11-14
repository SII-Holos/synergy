# Decision Record: Type unavailable config fields like their runtime parser

Status: implemented

## Problem

A minimal organization CLI consumer includes the shared CLI implementation without optional LSP type augmentation. Experiment fields whose owners are absent have an unavailable runtime parser, but their static type was `unknown`. Forwarding an otherwise valid native request to the generated SDK then failed to compile. The full CLI program hid the mismatch by including the optional owner's augmentation.

## Decision

`ConfigExtensions.field` types an exact unowned field as optional `never`, matching its existing `z.never().optional()` runtime behavior. A registered owner's declared schema retains its own type. A dynamic string key remains unknown because its owner cannot be inferred statically. Runtime lookup and parsing stay dynamic and unchanged.

## Alternatives considered

**Load the optional LSP owner in every CLI consumer.** An unrelated service entry must not acquire an optional product merely to make a type augmentation visible.

**Cast or drop experiment overrides at the SDK call.** Neither fixes the public field type, and either would obscure validation or lose input.

## Consequences

Minimal consumers and the full product compile against the same generated SDK while preserving unavailable-owner rejection. A focused compile-time assignment verifies the absent literal type; runtime tests retain early references, later registration and independent owners across Runtimes. The organization consumer and Harness type checks pass without transport casts or new optional imports.
