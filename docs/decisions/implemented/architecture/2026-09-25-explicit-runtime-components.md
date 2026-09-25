# Decision Record: Explicit Runtime components

Status: implemented

## Problem

Independent libraries did not provide a complete embedding composition. Full product registration connected configuration, reload, workers, routes and service cleanup centrally, while domain CLI helpers introduced reverse application dependencies. Installing the plugin executor also installed the authoring toolchain.

## Decision

Harness owns a typed component definition and validates its graph before registration. Each Runtime owns registration and resource state independently. Agent Runtime provides the Bun embedding entry and in-process client with an explicit data home and selected components. Domain packages own component factories, reload contributions, lazy HTTP adapters and role-specific worker entries. HTTP transport combines registered owners before constructing the application. Local Runtime owns generic reload orchestration; optional domains supply handlers through a focused Harness port.

Required versions, duplicate identities and dependency cycles fail before storage opens. Partial startup disposes started resources in reverse order. Resident ready hooks run after all selected residents have prepared, so scheduling can depend on active transports. Server started hooks run only after all readiness and background initialization finishes; Plugin Host owns pending install delivery and the runtime-started notification. CLI owns terminal reporting and process shutdown, with domain status callbacks supplied explicitly. Worker processes receive the host selection explicitly and reject absent or mismatched component metadata. Browser hosting and other foreground-only services are excluded from worker entry modules.

Each first-party optional component publishes matching package metadata. Release versioning updates its host and component requirements together. Module builds preserve owner package references and worker URLs even for nested output directories. The authoritative catalog separates core, full backend/HTTP, Web assets and the Desktop application. A component’s CLI adapter contributes lazy root commands and nested debug, data or plugin-authoring commands to the single CLI parser. Namespace collisions fail before execution. Plugin Kit is itself optional, and ACP declares its required HTTP transport. Source and installed hosts share that command composition.

Shared terminal and command-definition primitives live in Util; network and Scope host adapters live in Local Runtime. Plugin Host accepts explicitly supplied authoring commands and does not depend on Plugin Kit. Ordinary plugins retain their process runtime and capability-gated Host Services.

## Alternatives considered

**Expose only more package subpaths.** Subpaths do not compose lifecycle, version checks, worker selection or cleanup.

**Scan packages or expose a universal service container.** Discovery would make embedding depend on ambient installation state and hide missing typed dependencies.

**Use the Pi extension execution model directly.** Pi's package model informs independent distribution and composition, but Synergy's native ownership, permission and process plugin semantics require explicit host contributions.

## Consequences

The same component objects can be reused by isolated runtimes. Domain owners can be selected independently without registering another owner's configuration. Presets replaces the ambiguous Product Runtime package and uses the same Agent Runtime factories for full startup. Server owns static asset routing through an explicit web-app component; app payloads stay application-owned. Runtime tests cover isolation, native worker readiness, failed-start cleanup and independent HTTP contributions; generated CLI documentation follows explicit authoring contributions.

The public full backend takes an explicit Web asset directory; repository asset lookup is confined to source CLI composition. Runtime startup generates the editor schema from its sealed active configuration contracts, so installed and embedded subsets do not inherit unrelated product fields.

## Sources

- [Pi package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md): independent packages and explicit composition metadata.
- [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md): extension model comparison; Synergy retains its own execution and trust semantics.
