# Decision Record: Unified experimental feature lifecycle

Status: implemented

## Problem

Incomplete product modules were registered with the complete preset and exposed as ordinary capabilities. Business settings such as `boss.enabled` did not remove module routes, Agents, tools or UI. Source and installed component selection duplicated dependency traversal, while offline data maintenance required Lattice execution ownership. Smaller prompt and context experiments also needed an instance-wide lifecycle without another configuration system.

## Decision

Owner-local pure declarations feed one Util selection algorithm and generated installed metadata. Harness owns Runtime-local effective state and the global opt-in domain. Restart choices select components before registration; live choices are read at existing operation boundaries. Server capabilities and the experimental settings catalog derive from this state. Boss, Lattice and Kanban default off for fresh and existing installations; their business data remains stored. Explicit bridges cannot reactivate unavailable participants. Lattice maintenance registers data schemas and migrations separately from execution. Complete contract generation selects every declaration explicitly.

Graduation removes alternatives and retires choices through versioned config migration. Developer guidance routes substantial new product or model behavior through this lifecycle. The [architecture reference](../../../architecture/feature-lifecycle.md) and [development workflow](../../../../.synergy/skill/develop-feature/SKILL.md) own the maintained rules.

Managed readiness protocol 2 distinguishes candidate selection from active components. Worker protocol 2 requires the same parent feature plan in source and installed processes, with a shared schema rejecting components outside that plan. Configuration writes and imports share dormant-field preservation, and global-only validation applies before either path writes files.

The plan retains required relationships so saved-choice status reuses startup dependency evaluation instead of maintaining a second resolver. Stable owners cannot depend on experiments indirectly through bridges. Composition validates active factory presence and exact versions before loading adapters or registering capabilities. Settings retries use the existing save coordinator so page recovery and the shared save status cannot diverge.

The feature catalog keeps both startup-unavailable and runtime-shutdown responses in its 503 OpenAPI contract. Owner tests explicitly select their experiments; ordinary product fixtures retain the default-off plan. Offline maintenance dependencies remain installable without becoming mandatory runtime requirements.

## Alternatives considered

**Only hide UI or reuse business enable settings.** Routes, tools, Agents and background work would remain registered, so presentation and actual availability would disagree.

**Separate module toggles and behavior experiment systems.** Parallel configuration, catalogs and lifecycle semantics would make future features harder to maintain and graduate.

**Dynamically unload modules or persist task feature snapshots.** Restart activation provides a bounded composition change. Live behavior needs only an operation-local choice; persistent history and unload state machines add machinery without serving this scope.

## Consequences

Restart experiments require an explicit restart and retain dormant data. Module dependencies must distinguish optional integration from stable ownership. First-party packaging and generation validate feature declarations. Existing users must opt into the three experiments, even when retained business settings enable their internal behavior. No user cohorts, traffic allocation, task snapshots or changes to actual prompt/context strategies are introduced.
