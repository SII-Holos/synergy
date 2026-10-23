# Feature lifecycle

This reference defines first-party feature availability. Product experiments are independent of plugin permissions, business configuration and execution-parameter `Experiment` files.

## Declarations and ownership

`FeatureDefinition` in Util defines an ID, owner, maturity (`experimental` or `stable`), activation (`live` or `restart`), name, description and optional component binding. A component binding requires restart activation. A feature without a component binding can select a behavior inside its existing owner. Each package declares its features in `src/features.ts`, independently of executable registration. Components are classified as product, foundation or bridge; product components require declarations. `feature:gen` validates declarations and generates package metadata and Web translation descriptors; `feature:check` prevents omissions and drift. Installed launchers read that metadata before importing executable components. Plugin API4 authorization and lifecycle remain separate.

Util owns schemas and the pure `FeatureSelection` algorithm. Harness owns Runtime-local `Features`, configuration and reload integration. Domain packages own behavior and lifecycle. Presets and the installed launcher supply candidates to the same selection algorithm. Server publishes the resulting state; Web consumes it without interpreting raw preferences as effective availability.

## Preferences and effective state

The instance-global `features` domain is `config/synergy.d/140-features.jsonc` under the runtime root:

```json
{ "features": { "optIn": ["boss"] } }
```

The list contains only explicit experimental choices, defaults to empty and replaces the previous list on write, including imports with append mode. Project and Session overrides are unsupported. Pre-bootstrap and runtime configuration use the shared feature-file reader. Existing config-domain APIs own validation, atomic writes, export/import and reload; there is no second toggle API. Domain writes and imports share preparation that preserves dormant owner fields. Uninstalled choices remain removable in Settings and cannot install packages or enable dependencies.

`Features.enabled(id)` reads the active Runtime, never process-global mutable state. `GET /global/features` returns declarations, saved selections, availability, effective values and pending-restart reasons. `GET /global/capabilities` publishes actual HTTP capabilities from the same state and selected HTTP owners. Both refuse requests before readiness. A stable declaration ignores old opt-ins.

Restart choices change the next component plan. Saving does not register or unregister services in a running process. Live choices update through configuration reload; the owning operation reads once at its existing entry and retains that local boolean through its execution. Prompt alternatives are selected at the existing prompt assembly point before dispatch. Future worker-side consumers pass their operation choice through the existing request context; a worker must never reconstruct component selection from mutable configuration. No feature fields are added to tasks, execution snapshots or history storage.

The plan retains candidate identities and required relationships. Startup, plan validation and the saved-choice preview use the same dependency evaluation. A plan whose active components contradict its choices is rejected. A pending restart compares the next effective value with the current value, including changes caused by an owner's dependencies. Enabling a live behavior inside a dormant owner still waits for that owner's restart. The preview never changes active capabilities.

## Composition and dependencies

Selection precedes registration, HTTP/CLI adapters, worker plans and service startup. Source, installed and embedded entrypoints use the same resolver. Harness validates the plan against the supplied factories before registration or adapter loading; missing active components and version mismatches fail startup. Worker protocol 2 requires the parent's pinned feature plan; source and installed workers share one schema that rejects missing plans, disabled components, duplicates and version mismatches before registration. Schema, SDK and command documentation generation use `FeatureSelection.complete()` explicitly, independently of a developer's preferences.

Managed readiness protocol 2 reports the versioned candidate `selection` separately from actually registered `components`. The SDK validates requested candidates against the resolver's selection, so a disabled experiment is not a startup failure. Attach mode continues to verify requested active components through capabilities. No client computes feature defaults or dependency closure.

A bridge is selected only when its required participants are selected. It cannot pull an experimental participant back into the plan. A stable component cannot require an experimental component, directly or through another component: move that integration into a bridge. The resolver rejects such declarations even when the experiment happens to be enabled.

Boss and Lattice bind their entire components. Their bridges (`boss-feishu`, `channel-lattice`) follow ordinary requirements. Kanban belongs to Workbench and gates only the board's capability, navigation, deep links, mounting and subscriptions. Workbench, Blueprint, Agenda, Library and ordinary Feishu remain available independently. `boss.enabled` is a business setting evaluated only inside an assembled Boss module; it cannot opt in to the experiment.

Dormant business configuration and history stay stored. Existing Session execution-owner checks block resuming unavailable workflows without deleting history; new ordinary human messages retain the existing [independent task-root contract](session-and-messages.md#task-roots). Lattice exposes a separate maintenance entry containing schema and migration registration. Offline data maintenance loads that contribution when Lattice is dormant, without registering its workflow, tools, routes, recovery or resident service. Maintenance entry paths are checked against the sealed installation. Domain migrations retain their existing IDs and central ledgers.

## Product lifecycle

Settings always includes Experimental features. There is no enable-all control. Saved choices and pending restart are distinct from effective availability. All ordinary entrypoints, settings search, restored panels and mobile surfaces use capabilities; reconnect invalidates the previous Runtime's capability state and rejects late responses. A failed save retains the draft; retry uses the existing settings save coordinator, while failed catalog reads retry only the read.

Large product additions, substantial prompt/context changes and risky optimizations begin as experiments. Behavior-preserving refactors, mechanical changes and bug fixes do not automatically need switches. An experiment chooses behavior at one owning implementation boundary rather than cloning a subsystem.

Graduation changes maturity to stable, removes the old alternative and its tests and copy, and removes the obsolete opt-in through a new versioned config migration using `retireFeaturePreferences`. Removal also uses an explicit migration; unknown uninstalled IDs are never indiscriminately discarded. A different future experiment receives a different ID. Follow [Develop a feature](../../.synergy/skill/develop-feature/SKILL.md) for implementation and verification.
