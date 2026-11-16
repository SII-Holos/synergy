# Decision Record: Keep shared processes under explicit Host origins

Status: implemented

## Problem

Environment operations require native provenance, but formatter, language-server and terminal callers did not supply it. Replacing the missing value with a Host label would also let a Task paused during asynchronous resource preparation obtain a new process. Assigning a long-lived language server or human terminal to its first Task would give that Task ownership of a service used independently afterward.

## Decision

Formatter, LSP and PTY composition register fixed Host-origin ports before startup, including worker composition. A formatter inherits the selected resource frame's captured origin for its short operation; without a selected frame it captures its component's Host origin. A selected frame lacking provenance fails before process admission rather than falling back to Host authority.

Shared language servers and human terminals capture an independent Host origin for each operation. When invoked inside a resource frame, they first validate that frame's original origin and validate it again after asynchronous resource preparation, before accepting the prepared Host process. Task suspension during preparation therefore refuses the new process. After this acceptance, the shared service has its own lifetime: pausing the first Task does not stop its process or make it part of that Task's execution drainage. Environment and native Workspace use still retain physical ownership through process and stream completion.

The new Host operation preserves the selected Scope, Environment and Workspace. An explicitly empty selected Workspace cannot fall back to an ambient Scope directory. Callers snapshot command arrays, environment values and displayed Session identity before their first await. A PTY's optional Session association is presentation metadata; it does not invent a native root, Run or tool call.

## Alternatives considered

**Mint a Host origin whenever provenance is absent.** A missing origin in an existing resource frame can indicate a lost owner. Native marker fixtures prove refusal before effects instead of silently creating a new authority.

**Keep the first Task's origin for every shared process.** A long-lived language server or human terminal remains useful after the initiating Task pauses. Actual native echo and Session-drainage checks demonstrate separate lifetimes without releasing the physical Environment use.

**Validate the original Task only before resolving resources.** Real native provider preparation held across Task suspension admitted and executed both new language-server and PTY commands. The final original-owner validation closes that preparation window.

**Read mutable command and selector values after preparation.** Held native and Session reads changed the requested command, environment and terminal association. Entry snapshots preserve the accepted request while leaving subsequent caller edits independent.

## Consequences

These three process entrypoints have explicit provenance without a new permission model, raw origin labels or a generic Host fallback. Missing composition fails locally. Tests execute real native processes, inspect their canonical execution receipts, pause actual root/Run/tool owners during preparation, prove accepted shared services remain usable, and verify marker files and physical cleanup. The [postmortem](../../../postmortem/0122-shared-host-admission-outlived-its-task.md) records the preparation and mutable-input counterexamples. Other Host resource consumers, remote executors and untested native platforms remain separate verification work.
