# Decision Record: UI API 5 with domain-owned frontend presentation

Status: implemented

## Problem

Plugin frontend extension points exposed isolated components without a complete workbench composition model. Settings used different props, presentation code depended on private state and routing, CSS ownership was implicit, and source-template builds could pass without any installed contribution rendering. Adding more slots to that arrangement would preserve fragmented state and author workarounds.

## Decision

UI API 5 versions executable frontend presentation separately from Backend Plugin API 4 and IPC 9. One `{ context }` entry provides typed domain services, generated plugin operation/event types, host components and an explicit lifetime. Default presentations and external Shells consume those services while existing domain controllers own synchronization, drafts, submission, resources, permissions and Browser pages. [Frontend plugin ownership](../../../architecture/frontend-plugin-platform.md) defines the maintained architecture.

Shells replace layout and finite pages and must expose the required extension outlet. Themes own semantic colors; structured Skins own materials and packaged resources. Plugin Kit emits a complete hashed UI graph and scopes CSS through syntax trees. The host validates author-declared UI versions before execution, stages registry generations, preserves a valid generation on failure and offers recovery before loading third-party code.

Authoring preview and acceptance tests run the real production host with explicit fixture approval and isolated homes. Packed templates are exercised through the registered presentation path. The functional and workbench/Skin samples depend only on public packages. Coverage prepares public package import artifacts through the build graph so clean checkouts exercise the same boundaries as normal package tests.

## Alternatives considered

- More ad hoc slots and component-specific props would keep authors coupled to private host details and duplicate state ownership.
- Unrestricted stylesheet replacement would make material customization easy but couple skins to private DOM and permit accidental effects on unrelated plugins and protected surfaces.
- An iframe tier would impose a second runtime, component and event model and would not support the chosen native workbench composition scope.
- Retaining UI4 execution through adapters would preserve multiple prop, style and lifecycle paths. The independent UI major makes the frontend break explicit while preserving backend API4 functionality.
- A simulated preview host would allow authoring tests to pass while production registration, approval or mounting failed.

## Consequences

Authors can replace workbench presentation and compose independent functional plugins without taking over host domain state. The public API includes presentation view models and lifecycle obligations, so it must be tested as a supported author-facing interface. UI4 executable components require migration and rebuilding. Trusted JavaScript remains trusted code; CSS scoping and process lifecycle are not security sandboxes. Browser modules remain cached after disposal, and recovery from a synchronous plugin loop requires a reload. The real-host suite adds build/browser runtime cost but detects failures that manifest or template-text checks cannot.
