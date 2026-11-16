# Decision Record: Preserve native publication input priority

Status: implemented

## Problem

A native target package arrived with Core before its organization owner. Publication reconstructed the owner order from manifest keys, making the organization owner read a Session that Core had not published. Switching to incoming contexts alone was insufficient: a FIFO topological queue let an already-ready observer overtake Core when Workspace publication unlocked it.

## Decision

Keep validation of the complete manifest owner graph. After the captured publication contexts are proven complete, rank owners by their first appearance in that context collection. On every topological step choose the earliest ranked currently eligible owner, including an owner that has just become eligible. Explicit publication edges still override that rank, and every owner's aggregate members keep their original parent-first order.

Do not add a controller-specific owner order or a second dependency authority. Staging snapshots the context collection before owner callbacks, and publication remains inside the existing epoch activation transaction.

## Alternatives considered

**Use manifest object-key order.** The manifest carries compatibility versions; its serialization order does not preserve the captured publication plan.

**Append newly eligible owners to a FIFO queue.** This needlessly changes incoming priority whenever an earlier owner depends on a later catalog publisher.

**Publish Core unconditionally first.** That violates the real Workspace catalog prerequisite.

## Consequences

The owner-level ready set is bounded by registered contributions, independently of Session and record counts. Cycles and missing owners retain their existing failure behavior. The fix preserves prior incoming ordering when dependency constraints allow it and does not authorize new staged reads, file installation, activation or execution.

## Verification

The real two-Home publication test includes a downstream owner whose native Session read requires published Core, in addition to Workspace prerequisites and parent/child order. It reproduces both overtaking failures. Native organization target activation and the enrolled HTTPS handoff controller suite also pass. See [the incident](../../../postmortem/0109-native-publication-lost-input-priority.md).
