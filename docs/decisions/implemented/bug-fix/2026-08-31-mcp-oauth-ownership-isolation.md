# Decision Record: Isolate MCP OAuth ownership and harden observability

Status: implemented

## Problem

`synergy mcp auth <server>` failed with `Authentication failed` / `Authorization cancelled` immediately after opening the browser for any OAuth remote server (reproduced with Notion, 2026-08-31). The CLI process log ended right after `opening browser for oauth` with no callback received and no error line, making the failure unobservable.

Root cause: the MCP supervisor's background auto-connect (default `startup: "eager"`, `MAX_CONCURRENT_STARTS = 3`) shares the process-level `PendingOAuth` registry with the interactive OAuth flow. When a queued background connect for the same server reached 401, `connectPipeline` ran `PendingOAuth.disposeIfIdentity(handle.name, handle.identity, "connection restarted")` or `PendingOAuth.register` (which replaces the existing entry and fires its `onDispose`), and the interactive flow's `onDispose` — `clearPendingOAuthState` — called `McpOAuthCallback.cancelPending`, rejecting the callback wait with `Authorization cancelled`. The CLI then exited via `process.exit()` before the supervisor could write its "requires authentication" log, producing the silent failure.

Additional gaps found along the same ownership line:

1. `McpAuth` kept an in-process cache (`auth.ts`) that was never invalidated in production, so a CLI-authenticated token was invisible to a long-running server process until restart.
2. Background connects used the interactive `McpOAuthProvider`, whose `saveState`/`saveCodeVerifier`/`saveTokens` wrote into the shared `authMcp` file, overwriting interactive-flow state mid-flight (state-mismatch risk).
3. `PendingOAuth` entries were created by background 401 probes on every connect attempt, repeatedly re-registering clients and widening the race window.
4. `cancelPending` rejected silently; CLI auth failures were only printed to the terminal, never logged to file; the fixed callback port 19876 failed with a bare message when already in use.

## Decision

Keep the CLI direct-connect architecture and eliminate the race by separating background probing from interactive ownership:

- **R1 — `McpAuth` reads go to disk every time.** Removed the module cache (and the now-dead `invalidateCache()` shim); `all()` reads `Global.Path.authMcp` directly. CLI-written tokens are visible to the server process on its next read.
- **R2 — `McpOAuthProvider` gained a `mode: "interactive" | "background"` (default `interactive`).** In background mode, `saveCodeVerifier`, `saveState`, and `saveClientInformation` are no-ops and `codeVerifier()`/`state()` return provider-local memory values, so a background probe never writes PKCE state into the shared `authMcp` file. `saveTokens` is also a no-op while no stored entry exists (probe-only), but persists when the store already has a token entry so SDK refresh-token renewal survives; `tokens()`/`clientInformation()` always read live from disk so an already-authenticated server connects directly.
- **R3 — supervisor background connects never touch `PendingOAuth`.** Removed the `disposeIfIdentity` call at the top of `connectPipeline`; the 401 branch now closes the failed client and transitions the handle to `NeedsAuth` (with an actionable `lastError`) instead of registering a pending entry. A single `setInterval` (30 s, `unref()`-ed, lazily started when a handle enters `NeedsAuth`, cleared when none remain) checks each `NeedsAuth` handle: reads `McpAuth.getForUrl` locally, reconnects when the stored tokens are valid or expired-but-refreshable (has a refresh token), skips the handle while an interactive `PendingOAuth` entry exists, and never issues network calls without local credentials. `reset()` clears the timer. `checkNeedsAuthNow()` exposes one pass for tests.
- **R4 — observability.** `cancelPending` logs a WARN with `{ mcpName, reason }` before rejecting; the callback-port-in-use error names `SYNERGY_OAUTH_CALLBACK_PORT` as the escape hatch; the CLI `auth` handler writes `mcp auth failed` to the file log in every failure branch.
- **R5 — behavioral regression tests** in `test/mcp/oauth.test.ts`: a background 401 during an interactive wait no longer cancels the pending callback and the interactive flow completes end-to-end; background provider never persists state and sees externally written tokens immediately; `NeedsAuth` recovers automatically once credentials appear; callback-port conflict produces an actionable error.
- **R6 — follow-up fixes from review.** `needs_auth` status now carries an `error` field (mirroring `needs_client_registration`) so the actionable `synergy mcp auth` hint reaches the CLI status line and any status consumer, not just the file log; the SDK/OpenAPI contracts were regenerated to match; the background-provider token-persistence and expired-but-refreshable recovery behaviors above are covered by new tests; the `invalidateCache` no-op shim was removed along with its test call sites.

Behavioral coverage: `test/mcp/oauth.test.ts` (new "MCP OAuth race and recovery" describe) plus the existing `pending-oauth.test.ts`/`supervisor.test.ts` suites staying green unchanged.

## Alternatives considered

- **Server-hosted authentication (CLI delegates OAuth to a running server via `--attach`)** — rejected: changes the CLI behavior contract, depends on a running server, adds a dual-process test matrix, and the fallback path would still need this fix.
- **Minimal patch: pause background connects for a server while an interactive flow is pending** — rejected: closes one race exit but leaves the stale-cache gap, the cross-process state-file overwrite, the repeated registration probes, and the observability gaps.
- **Add conditional-replacement/locking semantics to `PendingOAuth`** — rejected: background connections would still own registry entries and write state files; cross-process interference remains.
- **Database or shared-state service for `authMcp`** — rejected: over-engineering for a small single-file JSON store with no concurrency-volume justification.

## Consequences

`synergy mcp auth <server>` is stable under concurrent background connects; the interactive flow owns `PendingOAuth` exclusively. A server process recovers within ≤30 s after CLI authentication without restart, because reads are live and the NeedsAuth timer reconnects when tokens appear. Unauthenticated servers stop re-registering clients in the background (zero network traffic while `NeedsAuth`). Failures are now visible in both terminal and file logs. The trade-offs: every `McpAuth` read is a disk read (small file, non-hot path — connections/status only); background probes that hit 401 no longer keep the transport alive for a later finishAuth (the interactive flow always creates its own transport, so nothing is lost); the 30 s recovery interval is the worst-case reconnect latency; the callback port remains fixed with a clear conflict error rather than dynamic port selection, keeping `redirect_uris` consistent with server-registered clients.
