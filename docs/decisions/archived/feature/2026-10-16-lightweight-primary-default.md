# Decision Record: Lightweight primary as the initial default

Status: implemented
Archived: 2026-10-30

## Problem

An initial Agent choice should favor concise, direct execution while allowing users to choose a broader general or coding workflow. Catalog ordering and backend implicit selection must agree, including when a configured default becomes unavailable.

## Decision

Pico, the lightweight primary, is the fallback when resolved Scope configuration has no selectable `default_agent`. A valid configured primary remains first. If Pico is unavailable, selection falls through to another visible primary; absence of any visible primary remains an explicit error. The Agent catalog applies the same eligibility rules so a fresh Web composer receives the matching order.

Existing Session choices, explicit composer intent, prompts, permissions and model routing retain their existing behavior. No stored configuration or Session migration is required. See [Session Agent selection](../../../architecture/session-and-messages.md).

## Alternatives considered

**Keep Atlas as the fallback.** This retains the broader general workflow as the implicit entry point instead of the requested lightweight behavior.

**Write Pico into every configuration or Session.** This would overwrite deliberate choices and turn a default-selection change into a persisted-data rewrite.

## Consequences

Fresh unconfigured sessions select Pico in both the composer and implicit backend execution. Users can retain Atlas, Forge or a custom primary through explicit configuration. Tests cover configured selection, invalid defaults, unavailable Pico and the absence of any visible primary.

Superseded by [Atlas primary and text replacement as the code defaults](../../implemented/feature/2026-10-30-atlas-primary-and-replace-file-interface-defaults.md).
