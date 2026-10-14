# Decision Record: Keep Loop state visible through independent review

Status: implemented

## Problem

A bound Blueprint could enable submission without displaying its title or execution state. Light Loop controls did not distinguish review, requested changes or the final result, and compact composer styles hid their labels. Pure slot-selection tests did not establish that a status control was mounted.

## Decision

The composer presents Light Loop and BlueprintLoop through one labeled entry above the editor. Its node and geometry survive stage changes, including a pending terminal lookup. The detail dialog exposes task text, review reasons, failures and related resources. Existing pause, continue and abandonment controls retain their meanings. Terminal display is independent of active workflow occupancy.

Active Session metadata and existing Blueprint events supply live state. Known loop identities and loaded message metadata permit targeted canonical snapshot reads; clearing a workflow, ending an assistant turn or completing a reviewer task cannot establish approval. The client retains a bounded metadata cache, fences asynchronous results by owner and generation, and lets newer Blueprint events supersede older reads. It does not poll or load message bodies for status presentation.

## Alternatives considered

**Restore separate toolbar icons.** Icons alone do not explain review or failure and lose their labels in compact layouts. They also duplicate inspection and workflow controls.

**Infer success when the Session becomes idle.** Review, cancellation and failure all have idle intervals. Only the owning Loop's canonical result establishes acceptance.

**Refetch the conversation on each stage change.** Loop metadata and targeted terminal records already contain the required state. Reloading conversation content introduces redundant traffic and reading-position changes.

## Consequences

A result can remain visible after its active binding is released, while new work can still start. A terminal lookup has explicit pending and retry states. Component tests cover the mounted Composer; browser tests cover narrow geometry and keyboard dismissal. Controlled model responses drive real isolated Loop execution through rejection, failure and approval for visual acceptance.
