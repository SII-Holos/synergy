# Decision Record: Default Home Workspace

Status: implemented

## Problem

New Home conversations have no default Workspace, so ordinary file tools are absent even when a native execution Environment is selected. Using the entire user home as the implicit file target would mix task output with unrelated user files. Configuration and credentials also need a different lifecycle from agent-authored working files.

## Decision

Local Runtime provides a shared directory Workspace at `<RuntimeHost.root>/workspaces/home`. It creates the directory and registers its verified identity through the existing Workspace catalog only when a new Home session has no explicit selection or same-Scope parent binding. Directory creation happens before the Session's storage transaction. Subsequent sessions reuse the catalog identity and durable files.

Home Scope retains `local: null`. Bare Scope entry, history reads, imports and existing sessions do not acquire this default. Explicit Workspace IDs or descriptors, explicit null and inherited parent bindings remain authoritative. The `current` selection preserves an absent Home binding rather than silently restoring files. Hosts without local Workspace services retain null defaults.

The path follows the Runtime root, including isolated `SYNERGY_HOME` installations. It is a normal directory Workspace, not configuration, cache, a new storage backend or a per-session sandbox. Existing Environment compatibility, tool availability and execution policy remain unchanged. No stored schema or historical binding migration is required.

## Alternatives considered

**Use the operating-system user home.** Rejected because general task files should not default to the same directory as unrelated documents and application settings.

**Put working files inside configuration or cache.** Rejected because configuration contains executable instructions and settings, while cache can be cleared independently of durable user work.

**Change Home Scope into a local project.** Rejected because conversation/configuration ownership and selected files are separate; a Session default can use the existing provider without reversing that architecture.

**Backfill every null Home session.** Rejected because null can be an intentional selection and existing history must not silently gain a different file target.

## Consequences

New default Home sessions expose Workspace-dependent tools and retain output across restarts. Default Home sessions share files and may modify the same paths. Clearing the Workspace still removes file-dependent tools. Session deletion does not delete the shared directory. Unusable directory creation or catalog identity errors fail creation rather than falling back to another directory. Focused regressions cover defaults, explicit choices, inheritance, concurrent registration, Runtime isolation, reopening, HTTP selection and model-facing tool availability.
