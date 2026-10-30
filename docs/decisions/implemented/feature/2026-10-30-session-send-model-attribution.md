# Decision Record: Session-send model attribution

Status: implemented

## Problem

`session_send` already persists `origin: agent` and the sending Session identity, but the target Agent's model prompt receives only the forwarded user text. A target Agent therefore cannot reliably distinguish a direct human message from a message delivered by another Session when both contain the same content.

## Decision

`session_send` adds a separate hidden `system`-origin text Part containing a compact `<message-origin>` attribution record, while keeping the supplied content in its existing user-origin text Part. The canonical message remains a user message with `origin.type: "agent"`; the attribution Part is included in model projection and omitted from ordinary text extraction. `sourceName` is promoted into the canonical Agent origin label, and `session_read` renders that label beside the user role.

This is deliberately scoped to cross-session forwarding. It does not introduce a general prompt-projection registry, change `lateSystem`, or alter workflow wrappers. Future origins can adopt a broader projection owner if their requirements justify it.

## Alternatives considered

**Persist the attribution in the supplied user text.** Rejected because the frontend, history tools, search and canonical content would all see a presentation prefix instead of the original request.

**Add a general SessionPromptProjection for every origin and workflow.** Rejected for this narrow requirement because it would expand the prompt pipeline and migration surface before other origins need the same model-facing behavior.

**Only retain `sourceSessionID` metadata.** Rejected because canonical metadata is not currently included in the provider model message, so the target Agent still cannot distinguish the sender from ordinary user content.

## Consequences

The target model receives source attribution without changing the displayed message body. The frontend continues to filter system-origin Parts, while `session_read` uses canonical origin data to identify forwarded messages. The hidden attribution is persisted with the message and therefore remains available through normal history, compaction and retry projections.

Tests cover source-name canonicalization, model-visible attribution, unchanged user text, hidden marker filtering and `session_read` source labels. The existing permission and Inbox admission paths remain unchanged.
