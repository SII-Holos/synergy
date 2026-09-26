# Decision Record: Advance bindings when GitHub recreates a checkout

Status: implemented

## Problem

A filesystem can reuse a deleted directory's physical identifier. Comparing identifiers alone cannot establish continuity after the owner deliberately deletes and clones a checkout, so stale Workspace generations could remain valid for replacement files.

## Decision

GitHub checkout preparation rebinds an existing Workspace whenever it clones the directory. It retains the stable Workspace ID and advances the binding generation even if the physical identifier compares equal. Fetching and updating an existing checkout retains its generation when its identity is unchanged. Native retirement ownership still surrounds clone, binding publication and provider-record publication.

## Alternatives considered

**Rely only on physical identifiers.** They detect replacement in many cases but do not override the owner's direct knowledge that the directory was recreated.

**Change the shared filesystem identity format.** This would affect catalog and native coordinator semantics without eliminating identifier reuse. The lifecycle owner already has the decisive evidence.

## Consequences

Old file and execution references must refresh after provider-owned recreation. Session identity and ordinary checkout refresh are unchanged. A real Git regression injects identifier reuse at one Runtime's location source, making the stale-generation failure deterministic; the [incident record](../../../postmortem/0029-recreated-github-checkout-generation.md) preserves the native Linux reproduction.
