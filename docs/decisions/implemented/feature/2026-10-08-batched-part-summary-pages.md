# Decision Record: Batched part summary pages for Web window refresh

Status: implemented

## Problem

Refreshing a conversation page in the Web client issued one `GET /session/:id/message/:mid/part/page` request per rendered message — typically 5–10 parallel requests bounded by the 40-turn render window. On HTTP/1.1-only deployments (e.g. behind an nginx reverse proxy without h2) the browser's six-connection-per-origin limit makes most of these requests stall for seconds in the connection queue behind the large message-page response, even though each request is fast server-side (single request ~134 ms; 10 concurrent same-message requests ≤ 750 ms; 8 concurrent cross-message requests ≤ 530 ms measured). The visible symptom is a multi-second "refresh" wait that the per-message endpoint hierarchy cannot absorb.

## Decision

The refresh path fans in at both ends:

- A new route `POST /session/:sessionID/part/pages` (`session.partPages`) accepts up to 100 message IDs and returns each message's bounded Part summary page in one response, with identical validation, scope ownership, and error parity to the single-message `part/page` route (unknown messages surface the same server error, rather than a silent success). The domain layer (`SessionHistoryDisplay.partPageForMessage`, `SessionHistory.partPages`) shares the single-message implementation; the batch wrapper only adds per-message `requireDisplayMessage` parity and keying by message ID.
- The Web Part summary loader gains a batch reader (`createPartPageBatchReader`) that coalesces plain first-page reads (no cursor/partID/older) within one microtask into a single `session.partPages` call per session. Targeted reads — cursor continuation, partID targeting, older-history pulls — bypass the batch and hit the per-message route directly, because they carry query identity the batch contract intentionally does not model.
- Both viewport site loads (the latest-window initial hydrate in `sync.tsx` and the sidebar prefetch in `layout/index.tsx`) read through the batch reader, so a fresh session view issues one request for the rendered window instead of one per message.

## Alternatives considered

- **Keep per-message route, rely on HTTP/2 alone.** Enabling h2 at the reverse proxy removes the browser connection ceiling and is recommended independently; but it does not stop the fan-out building a queue of dozens of cold reads behind one 1.1 MB message-page download, and it leaves HTTP/1.1-only deployments (and direct socket access by tools) with the old stall.
- **Fold the window into the timeline/message page.** The timeline page already carries full message bodies; having it also carry per-message Part summaries for the refresh path would have duplicated the `partPage` contract inside the message contract and forced the timeline route to absorb the staleness/refresh semantics of `display_part`, which it intentionally does not own.
- **Batch all query variants (cursor, partID, older) in one route.** A generic batch covering every `partPage` query shape would need per-message query objects, complicating both the schema and every consumer's error handling; the stale-window refresh that motivated this change issues only plain first-page reads, so the route models exactly that and no more.

## Consequences

- A full-window refresh now issues 1–3 batched requests instead of 5–10 individual ones; the measured worst-case per-merge request (≤ 764 ms for 10 concurrent cold reads) becomes the ceiling for the whole window rather than per message.
- The change introduces a new wire contract (`SessionPartPages`) plus SDK surface generated via `./script/generate.ts`; consumers of `partPage` and `partPages` share the same validation/storage/error semantics through `partPageForMessage`, reducing drift but requiring that any future partPage semantics change be made in the shared function, not the route handlers.
- The batch reader drops late arrivals into a new batch rather than growing the in-flight one (microtask-scoped coalescing), so DOM-initiated late scrolling still issues small follow-up requests; targeted navigation reads (locate, load-earlier, load-more) are unchanged and untouched.
- The browser's six-connection HTTP/1.1 ceiling stays a deployment concern: enabling HTTP/2 at the reverse proxy is still recommended, but given this change the largest remaining post-refresh stall moves from the Part-summary fan-out to the single 1.1 MB message-page download.
