# Decision Record: Keep draft attachments in one horizontal row

Status: implemented

## Problem

Wrapping draft attachments displaces the message editor and changes the input surface height each time another row appears. Folding those rows also hides retry and removal controls behind another disclosure.

## Decision

The built-in composer presents every draft attachment in one horizontal scrolling row, in addition order. Images, documents, references and pending uploads share that row. Keyboard focus scrolls an offscreen action into view; failure review targets the retry control directly, and removal restores adjacent focus or the Add control. Uploading and failed counts remain visible above the row. There is no attachment expansion control in the composer.

The upload ownership, recovery and sent-message layout in [user attachment flow](../feature/2026-10-01-user-attachment-flow.md) remain unchanged. This refines only that record's draft row presentation; sent user attachments still fold after two measured rows.

## Alternatives considered

**Wrapping and folding the draft after two rows.** It consumes writing space and requires another expansion action before an offscreen attachment can be managed.

**Shrinking every card to fit.** It makes document names and retry actions unreadable as the attachment count grows.

## Consequences

The draft retains a predictable attachment height and readable cards. Larger attachment sets require horizontal scrolling, with native touch, trackpad and keyboard access. Original bytes, persistence, upload policy and Plugin interfaces do not change.
