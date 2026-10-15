# Decision Record: Keep Loop state visible through independent review

Status: implemented

## Problem

A bound Blueprint could enable submission without displaying its title or execution state. Light Loop controls did not distinguish review, requested changes or the final result, and compact composer styles hid their labels. Pure slot-selection tests did not establish that a status control was mounted.

## Decision

The composer presents Light Loop and BlueprintLoop through one compact row at the bottom of its pending-message stack, outside the editor. Queue and loop rows share surface geometry and labeled icon actions. Its node and geometry survive stage changes, including a pending terminal lookup. The goal editor and cancellation are direct actions; review reasons, failures and related review sessions stay behind an information action. Existing pause and continue controls retain their meanings. Cancellation stops the current loop and review; a failed request retains the goal. Async edits and actions remain scoped to their captured owner. Terminal display is independent of active workflow occupancy.

Active Session metadata and existing Blueprint events supply live state. Known loop identities and loaded message metadata permit targeted canonical snapshot reads; clearing a workflow, ending an assistant turn or completing a reviewer task cannot establish approval. The client retains a bounded metadata cache, fences asynchronous results by owner and generation, and lets newer Blueprint events supersede older reads. It does not poll or load message bodies for status presentation.

Blueprint first-prompt delivery awaits execution. An abort while the Session pause latch is present belongs to the explicit pause/abandon operation, so the start callback cannot independently mark it failed. Real delivery failures, including transport aborts without a user interruption, still record failure. Cancellation tests exercise the real Session abort path and storage to protect that ordering.

## Alternatives considered

**Restore separate toolbar icons.** Icons alone do not explain review or failure and lose their labels in compact layouts. They also duplicate inspection and workflow controls.

**Infer success when the Session becomes idle.** Review, cancellation and failure all have idle intervals. Only the owning Loop's canonical result establishes acceptance.

**Refetch the conversation on each stage change.** Loop metadata and targeted terminal records already contain the required state. Reloading conversation content introduces redundant traffic and reading-position changes.

## Consequences

A result can remain visible after its active binding is released, while new work can still start. A terminal lookup has explicit pending and retry states. Component tests cover the mounted Composer; browser tests cover narrow geometry and keyboard dismissal. Controlled model responses drive real isolated Loop execution through rejection, failure and approval for visual acceptance.
