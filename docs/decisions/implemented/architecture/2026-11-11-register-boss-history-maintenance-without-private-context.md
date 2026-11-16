# Decision Record: Register Boss history maintenance without private context

Status: implemented

## Problem

Boss history is a native Session tree and Inbox ledger, but selecting its complete runtime also enables private Library identity, a Home-wide overview and Agenda provisioning. Importing history must not implicitly grant those capabilities.

## Decision

Expose a separate inert maintenance entry that registers the stored Boss Session schema and versioned portability proof owner. Core retains canonical Sessions, assignments and reports; Boss adds no alternate task authority. The complete Boss factory reuses maintenance registration and then explicitly registers execution and private context owners.

A maintenance-only Runtime has no Boss WorkflowKind, prompt contribution, agent or reload provider. It preserves stored workflow descriptors, while native execution-owner admission rejects Continue without real execution capability. Installed component metadata advertises the maintenance entry independently of normal feature selection.

## Alternatives considered

**Select the full Boss component for import.** This couples history access to unrelated private context and scheduling.

**Register a no-operation workflow executor.** Continue would appear successful without an owner capable of honoring the saved task.

**Drop the Boss descriptor on import.** This hides missing capability by losing the original workflow identity.

## Consequences

History maintenance and execution have separate capabilities. Organization execution still needs an explicitly scoped Boss context provider and safe Agenda ownership; maintenance alone does not satisfy that execution requirement. Focused fixtures verify retained tree identity, absent private components and agents, no overview delivery and an explicit native Continue refusal.
