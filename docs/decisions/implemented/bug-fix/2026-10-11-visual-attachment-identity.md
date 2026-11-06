# Decision Record: Separate visual content from its source attachment

Status: implemented

## Problem

A completed visual produces both inline content and a downloadable source attachment. Both timeline entries refer to the same tool Part. Matching visible entries only by message and Part makes the attachment replace the content and appear twice. Rendering the restored body also exposes a second gallery unless attachment ownership is explicit.

The composed conversation also exposes canonical state through Solid store proxies. Passing those proxies directly to the JSON contract rejects valid nested content and falls back to an empty state, so remote updates can fail to reach mounted visuals.

## Decision

The shared [activity projection](../../../../packages/ui/src/components/session-turn-activity.tsx) gives promoted tool attachments a separate identity. Ordinary Part identity remains stable when reasoning is promoted from a reasoning row to visible content. [SessionTurn](../../../../packages/ui/src/components/session-turn.tsx) owns conversation attachment galleries and disables the nested tool body's gallery. Standalone tool details keep their gallery by default. The original Part, source Asset and saved interaction state remain unchanged.

The shared [render context](../../../../packages/ui/src/context/render.tsx) reads `visualState` into a plain JSON snapshot before canonical validation. Serialization observes nested reactive fields, while the resulting snapshot excludes store internals and can cross the iframe bridge. The inline reader and App observer use this boundary; backend validation and the persisted format stay unchanged.

Interactive browser fixtures mount the real SessionTurn with a versioned visual and its source attachment. Projection coverage also exercises plugin renderers; static browser coverage verifies display-mode switches and remounts. Existing reasoning, ordinary activity and attachment tests retain their separate responsibilities.

State tests reconcile real store data and verify independent snapshots, while browser tests cover remote parameter changes, reset and restoration through the composed conversation.

## Alternatives considered

**Remove the source attachment.** This hides the collision but removes a supported entry to the same visual and leaves other dedicated renderers affected.

**Key every projection by its presentation kind.** Reasoning can change presentation when a completed response has no other content. Its source-to-visible match must survive that promotion.

**Remove galleries from every tool body.** Execution details do not have a surrounding conversation timeline to deliver attachments. Gallery suppression therefore belongs to the timeline caller.

**Unwrap the store before reading state.** Reading raw nested values would lose the reactive subscriptions needed for reconciled Part updates. A tracked JSON snapshot preserves those subscriptions without weakening the shared JSON schema.

## Consequences

The visual and one source attachment remain independently visible without changing persisted data or requiring regeneration. Dedicated plugin results receive the same identity protection. Tool bodies used outside a timeline retain their existing attachments, while the conversation continues to apply its delivery and evidence policies.
