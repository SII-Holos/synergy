# Decision Record: Explain and confirm project folder recovery directly

Status: implemented

## Problem

A project may have a readable main folder and an unavailable shared folder. A generic unavailable-Workspace prompt hides which folder failed, while an identity-changed recovery screen without a location action prevents an explicit replacement choice.

## Decision

The recovery dialog shows each failed folder's role, original path and reason without a nested details form. Every unavailable folder offers the existing project directory picker, including identity-changed folders. A replacement is staged beside the original path; only the explicit Continue action invokes canonical rebinding. The action names one or multiple remaining folders. Recovery does not start a task automatically or move existing task locations.

The shared picker retains its existing authority rule: a running managed Desktop connected to its own service uses the native OS dialog; Web and external Desktop browse the selected service. Native cancellation leaves the recovery plan unchanged and does not open a fallback picker. Native picker failures retain their shared toast feedback. The recovery dialog also handles propagated picker failures without losing its staged paths.

Environment hints identify whether the first failed write root is the selected Workspace or a shared writable Workspace, with its identity, catalog path, reason and diagnostic message. They describe write-root validation failure rather than claiming every project file is unreadable. The admission layer still rejects the failed root set; no partial writable root list or automatic rebinding is introduced.

The [project-entry product rules](../../../../apps/web/PRODUCT.md#project-first-task-entry) own the interaction. Verification uses the recovery dialog and model tests, the work-context integration suite, the real-service recovery fixture, and `packages/harness/test/session/system-environment.test.ts`.

## Alternatives considered

**Require manual path entry in another recovery form.** This duplicates existing directory browsing and does not preserve the native/Desktop versus remote-service distinction.

**Hide alternative selection for identity changes.** Continuing at the existing path is useful but cannot express that the intended folder has moved elsewhere.

**Ignore a failed shared root.** This would silently change the execution footprint. Recovery must retain all existing admission, revision and binding-identity checks.

**Aggregate all failed roots in the environment hint.** The execution-root resolver fails on its first invalid root. Collecting every failure would change that owner and is unnecessary for accurate attribution of the reported failure.

## Consequences

Partial recovery retains confirmed folders and retries only the remaining ones. Selecting a folder alone does not authorize file access. A Scope or connection change cancels pending recovery and ignores late picker results. The diagnostic path is read from catalog metadata after failure rather than captured in the original exception. Tests establish accurate prompt contents and unchanged admission, not improved behavior by a real model.
