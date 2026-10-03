# Decision Record: Consolidate task context in the conversation toolbar

Status: implemented

## Problem

Removing persistent composer controls left workspace identity, queued messages and scheduled activity without a coherent destination. Reusing the primary session status icon for worktrees obscured isolation while work was running. Directory verification failures provided no direct recovery target.

## Decision

The top-right Task details entry contains the actual session workspace, branch and environment, Inbox, scheduled activity and execution statistics. Each domain keeps its existing SDK and ownership boundary. Workspace and Inbox remain available independently of execution statistics. The bounded overlay scrolls as one surface and preserves Inbox operation ownership while its subview closes. Queries start on demand and stale responses cannot display another workspace's branch or environment.

Sidebar rows retain the primary runtime status and add an independent worktree marker. Workspace failures preserve their structured identity and open the existing revision-checked rebind flow after restoring the draft. Rebinding remains an explicit user choice. The composer has no Inbox anchor or execution spacer; QuickAction code remains registered but hidden.

## Alternatives considered

**Keep an Inbox button beside the composer.** This preserves the previous location but splits task information between unrelated corners and reintroduces layout pressure.

**Gate all task context on execution statistics.** This simplifies the overlay but makes workspace recovery and queued-message operations depend on an unrelated capability or failed query.

**Replace the runtime icon with worktree identity.** A single glyph saves width but cannot simultaneously communicate isolation and running or approval state.

## Consequences

Task entry stays quiet while contextual information remains reachable. The overlay owns navigation and focus; domain components retain their operation state. Longer paths wrap locally and never widen the chat. Related contracts remain in the [Web product specification](../../../../apps/web/PRODUCT.md).
