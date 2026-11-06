# Decision Record: Project navigation request state

Status: implemented

## Problem

Project creation can expand a locally tracked project after Layout startup. Sidebar expansion must cause a session-list request regardless of which creation surface opened the project. An absent list cannot distinguish an unrequested, pending or failed read, and empty projects need a completed state without any Session rows.

## Decision

Layout observes tracked expanded project identities and initializes unrequested lists through its existing generated SDK loader. Per-project requests use the shared navigation request owner for pending, accepted and failed states, duplicate suppression, client identity and disposal. Empty accepted pages complete loading. Sidebar renders progress only during an initial request and exposes Retry after initial failure; accepted rows stay visible during later reads. Supplemental projects retain explicit lazy loading.

Scope removal disposes its request and removes its page and request state. A delayed completion cannot restore removed project navigation. Project disclosures share one session-list rendering path while retaining the existing expansion and motion rules.

## Alternatives considered

**Load in each project creation callback.** Both Sidebar and task-selector callbacks would need identical lifecycle handling, and another tracked-project entry path could omit it again. Layout owns the tracked list and request state.

**Remove the spinner when a snapshot is missing.** That hides the symptom without loading the list, and cannot communicate a real pending or failed request.

## Consequences

A small request record is retained alongside each visited project page. Automatic initialization happens once per tracked expanded project; failed reads require an explicit retry or re-expansion rather than retrying on every reactive update. Real Layout regressions cover post-startup creation, empty results, failure, retry, retained snapshots and removal during an in-flight request. Sidebar browser tests cover the rendered spinner and retry alongside existing geometry and keyboard behavior. The request and store semantics are documented in [Frontend data sync](../../../architecture/frontend-data-sync.md).
