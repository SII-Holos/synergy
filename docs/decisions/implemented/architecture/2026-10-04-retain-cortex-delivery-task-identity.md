# Decision Record: Retain Cortex delivery task identity

Status: implemented

## Problem

A child Session can execute several Cortex tasks. A parent notification which identifies only the child Session cannot safely select a saved task result after that Session is reused.

## Decision

Cortex notifications capture the task identifier and title alongside the source Session. The canonical user-message origin exposes an optional task identifier. Historical Cortex notifications obtain that identifier only from the established Inbox delivery key through `MessageV2.deriveSemantics()`. This read projection leaves stored messages unchanged and never parses task identity from model-generated notification text.

Consumers must match the captured task and parent Session before presenting the child Session's saved output. Viewing a notification does not acknowledge task delivery or invoke `task_output`.

The implementation lives in [message semantics](../../../../packages/harness/src/session/message-v2.ts) and [Cortex notification delivery](../../../../packages/harness/src/cortex/manager.ts). The owning behavior is described in [Cortex](../../../architecture/cortex.md).

## Alternatives considered

**Read the current child Session output by Session identity alone.** Reused Sessions can contain a later task's output, so this would misattribute results.

**Rewrite historical messages or parse their notification text.** The existing delivery key already captures identity. A read projection avoids a persisted-state migration and language-dependent parsing.

## Consequences

New and historical notifications expose exact task identity without changing delivery acknowledgment. Older notifications without a recognized delivery key retain their source link but cannot claim an exact saved task result.
