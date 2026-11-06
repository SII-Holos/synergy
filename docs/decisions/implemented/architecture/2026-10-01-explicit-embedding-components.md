# Decision Record: Select every embedded runtime component explicitly

Status: implemented

## Problem

The embedded runtime installed Local Runtime and Plugin Host before resolving the caller's component list. A host could not omit these capabilities, and an empty selection still installed native execution and plugin configuration.

## Decision

Require `components` in `openAgentRuntime` and resolve exactly that list. CLI and Presets explicitly select their product defaults. Embedded hosts independently select native services, execution providers and plugin hosting through component factories. Worker plans derive from the same resolved selection.

## Alternatives considered

Per-capability disable flags retain an expanding implicit composition. A second embedding factory creates two public lifecycle paths. Both obscure the host's actual selection.

## Consequences

ToolExposure default groups can also be selected before group registration. An embedded host can select no built-in groups and register its own metadata for the same stable group identity. Full compositions retain their defaults; Runtime selection cannot affect another instance or replace a group after consumption.

Direct callers must name their required components. Product behavior remains unchanged through its explicit assemblies. Tests verify an empty runtime has no execution providers or plugin schema, two separate selections stay isolated, and real workers receive their owner's selected plan.
