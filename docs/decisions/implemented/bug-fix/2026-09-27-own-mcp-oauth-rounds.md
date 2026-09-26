# Decision Record: Own MCP OAuth rounds and coordinate concurrent refreshes

Status: implemented

## Problem

The credential invalidation hook added for [rejected refresh recovery](2026-09-22-mcp-oauth-dead-refresh-token-recovery.md) could delete tokens written by a concurrent login. A connection generation remained current while the new login finished exchanging its code and awaited asynchronous cleanup. A late successful refresh could likewise overwrite the new tokens. The SDK also permits concurrent authentication from ordinary HTTP requests and SSE reconnects: after one request rotates a refresh token, a second rejection of the old token must not clear the first request's result.

## Decision

MCP owns a Runtime-local authorization epoch for each server. Starting authentication invalidates the previous connection generation and claims the interactive epoch before asynchronous cleanup. Credential writes and invalidations check that captured epoch inside the existing serialized store mutation. Each SDK invocation captures its own credential snapshot; the same mutation compares the complete entry and advances the snapshot only after that invocation commits. A concurrent credential replacement therefore invalidates an old round even when the Runtime epoch did not change. Logout, disconnect, server replacement and shutdown revoke old operations before disposal. Revocation stops writes immediately; the interactive owner continues blocking background recovery until cleanup ends. Owner and connection-generation checks also protect PKCE cleanup and final reconnection, while cancellation of a superseded callback targets its exact state. The persisted auth format and public MCP status/API remain unchanged.

Both SDK transports use one `OAuthConnection` through their public fetch option. Ordinary MCP requests remain concurrent. Authentication challenges share an in-flight SDK `auth()` invocation; differing challenges wait for that invocation before reevaluating current credentials. Each invocation owns a separate provider. A late challenge first checks whether another request already refreshed the sent token with the required scope and an unexpired lifetime. A successful authentication permits one replay, retaining request contents and configured header precedence; another challenge is terminal. A caller abort only releases that caller's wait, while connection or owner disposal cancels shared authentication. Authentication has the configured connection deadline, with the existing thirty-second default.

The transport's automatic `authProvider` path is unused. Interactive code exchange also goes through the coordinator and SDK `auth()`, and duplicate finish calls share the complete exchange, cleanup and reconnect operation. SDK transports retain MCP framing, session headers, notifications, protocol negotiation and SSE behavior. Discovery, client registration, grant exchange and PKCE remain implemented by [MCP SDK 1.29](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.29.0/src/client); only HTTP challenge coordination is owned locally.

## Alternatives considered

**Connection generation alone.** It changes too late to protect an interactive exchange from an older background operation and does not distinguish authentication rounds on the same server.

**A mutable last-token snapshot on the shared provider.** The SDK reads `tokens()` for ordinary authorization headers as well as refreshes, and its save/invalidate callbacks carry no attempt identity. Concurrent reads can replace the alleged snapshot before a rejected request uses it.

**A promise cache around token-endpoint fetches.** Fetch completion precedes SDK persistence. Another old-token request can enter in that interval, and response cloning does not associate the later invalidation callback with its rejected credential.

**Serialize tool execution or fork the SDK.** The former unnecessarily removes MCP concurrency; the latter creates a second OAuth implementation to maintain. The public fetch and auth APIs expose the smaller coordination point required here.

## Consequences

Revoked credentials still converge to `needs_auth`, while late successes and failures cannot overwrite a later login. The coordinator becomes responsible for HTTP 401 and insufficient-scope 403 handling, cancellation, and one replay, so regressions exercise real HTTP and SSE clients and real SDK authentication. The tests retain parallel tool execution, rotating refresh, late challenges, scope changes, deadlines, Request properties, explicit headers, repeated finish, same-epoch credential replacement, owner replacement and held cleanup. No migration or new public configuration is required. Ownership remains within the existing single writing Runtime per Home; this change does not introduce cross-process credential writers.
