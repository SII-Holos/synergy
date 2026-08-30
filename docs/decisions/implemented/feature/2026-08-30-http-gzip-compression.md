# Decision Record: HTTP gzip compression for API responses

Status: implemented

## Problem

The Web frontend boot path transfers ~10 MB of uncompressed JSON per load: `scope/bootstrap` carries the full provider catalog (every model's metadata for every provider), config, agents, commands, sessions, and status, while `session/:id/message/page` ships up to 200 messages with fully inlined tool outputs. On a bandwidth-constrained or remote deployment this alone produced ~10 s of content-download time before the first screen could render. The server had no compression middleware anywhere in its Hono chain.

## Decision

Mount Hono's built-in `compress({ encoding: "gzip" })` middleware on the App chain in `packages/synergy/src/server/server.ts` — immediately after `cors` and before the shutdown gate, request-scope provisioning, and every route. The middleware's own guards carry the safety contract:

- `text/event-stream` is excluded by the default compressible-type regex, so `/event` and the other SSE routes stream through uncompressed without any route-level opt-out.
- Responses that already carry `Content-Encoding` or `Transfer-Encoding` are skipped, so the session-export gzip download and streamed responses are never double-encoded. A reverse proxy that already compressed a response is skipped for the same reason.
- Strong `ETag`s are downgraded to weak and `Cache-Control: no-transform` is honored.
- Requests without `Accept-Encoding: gzip` get the exact identity response as before.

Behavioral coverage in `packages/synergy/test/server/compress.test.ts` asserts the three public invariants: gzip round-trip on a large JSON endpoint, identity pass-through without `Accept-Encoding`, and SSE never being compressed.

## Alternatives considered

- **Reverse-proxy-only compression** — rejected as the sole fix: it leaves direct-connect deployments (local CLI, `bun dev`, headless servers without nginx) uncompressed, and silently regresses when a proxy config changes. Proxy gzip remains a valid extra layer; the honest skip path means the two never double-encode.
- **Per-route compression** — rejected: new JSON routes would forget it, and the middleware's type/encoding guards already handle stream and pre-encoded exceptions for the whole surface at once.
- **Payload slimming first (provider catalog, message page window)** — not a replacement: both payloads are legitimately megabyte-scale by design, and shrinking them is a separate, larger contract change. Compression buys ~70-90% on text JSON with three lines of code; payload work can still follow.

## Consequences

Boot-path transfer drops from ~10 MB uncompressed JSON to roughly 1-3 MB on the wire for clients that accept gzip. Compression is streaming (`CompressionStream` via `pipeThrough`), so large bodies are not buffered in memory before sending. Bun's native gzip powers the stream; CPU cost on these payload sizes is negligible next to network time.
