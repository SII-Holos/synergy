# Decision Record: Select host skills and describe callable tools

Status: implemented

## Problem

A host must describe only tools selected for the current model turn, and must explicitly choose whether local product skills and filesystem discovery participate in its composition. Discovering an operator home is inappropriate for an independently composed runtime.

## Decision

Session execution prompt contributions receive a detached, immutable list of callable tool IDs after core availability and host policy selection. Contributions cannot alter another contribution's capability guidance.

SkillSelection selects builtin names and filesystem discovery while composition is open, before catalog initialization. Selection is Runtime scoped; absent selection preserves the native product's existing behavior. Product skill entries continue to use the public instruction source registry and canonical manifest loader. No private Session resolver is exported.

## Alternatives considered

**Static tool hints.** They can advertise unavailable model capabilities.

**A host copy of skill discovery or the Session resolver.** It duplicates generic policy and loading mechanisms.

## Consequences

Hosts can provide model-specific capability guidance and deploy a bounded skill catalog without copying generic resolution. Selection cannot be changed by a model request or after discovery. Existing local-product catalogs retain all defaults.

## Verification

Harness domain contribution tests cover immutable capability input; local-runtime selection tests exercise actual Skill enumeration, filesystem exclusion, default product behavior and Runtime isolation.
