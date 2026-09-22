# Decision Record: Recover MCP servers from rejected OAuth credentials and terminal connection failures

Status: implemented

## Problem

A remote MCP server authenticated through `synergy mcp auth <name>` could become permanently unusable with no actionable signal. Reproduced with a Notion remote MCP server whose stored refresh token had been revoked server-side: the server sat in `failed` forever, `GET /mcp` reported the literal string `unknown error`, and `POST /mcp/:name/auth` — the documented re-authentication entry point — answered HTTP 500.

Three defects combined:

1. **The SDK credential-invalidation hook was missing.** `auth()` in `@modelcontextprotocol/sdk` calls the optional `provider.invalidateCredentials('tokens')` when a token request is rejected with `invalid_grant`, then retries; `McpOAuthProvider` did not implement it, so the rejected credentials stayed on disk and the error propagated.
2. **The error type decided the state route, and this type was not handled.** `InvalidGrantError extends OAuthError` and is not an `UnauthorizedError`, but the supervisor classified recoverable authentication failures solely with `instanceof UnauthorizedError`. A rejected-refresh-token failure therefore fell into the generic transport branch and exhausted the retry budget into the terminal `failed` state, which has no automatic exit.
3. **That transport branch discarded its cause.** It wrote only a local variable, so `handle.lastError` stayed unset: `GET /mcp`, the `mcp.failed` event, the Web UI, and the default-level log all reported `unknown error`, and the one line carrying the real message was `log.debug`, suppressed at the default INFO level.

## Decision

Make every MCP connection failure either recoverable or self-describing, using the owning components rather than a parallel mechanism:

- **`McpAuth.clearTokens` deletes only the `tokens` field of an entry**, preserving `clientInfo` so re-authorization does not silently degrade into repeated dynamic registration.
- **`McpOAuthProvider.invalidateCredentials` implements the SDK's hook** for scopes `tokens`, `verifier`, `client`, and `all`; `discovery` is a no-op because Synergy persists no discovery state. Background probes keep the ownership boundary established when MCP OAuth ownership was isolated: they write credentials only when a stored entry already exists, and they never clear `clientInfo`, so a background probe cannot disturb a concurrent interactive login. Because the SDK now clears rejected credentials, a revoked refresh token routes to the recoverable `needs_auth` state and `POST /mcp/:name/auth` returns an authorization URL instead of HTTP 500.
- **The generic transport failure branch records the primary transport's sanitized message on the handle.** The supervisor tries StreamableHTTP and then SSE, so the first transport's failure is the primary diagnosis rather than the fallback's; the message passes through `ObservabilityRedaction.text` with an explicit 4096-character ceiling before it reaches any log, HTTP response, event, or UI surface.
- **The shared sanitizer now covers quoted and bare-key forms.** Widening where the transport message travels also widened where a remote response body can echo credentials, and `SecretPatterns.keyValue` matched only unquoted `key=value` text, so every JSON body form (`{"token":"..."}`, `{"apiKey":"..."}`, `{"X-Api-Key":"..."}`) passed through unredacted. The pattern now accepts an optional quote on either side of the separator and `queryParam` also covers a bare `?key=`. `keyValue` and `queryParam` are read only by `ObservabilityRedaction.text`, so the change has a single consumer and does not alter the separate `standalone` and `longForm` rules used by the secret detector and SmartAllow.
- **`handleConnectFailure` reports the same sanitized cause** in its single default-level WARN and in the `mcp.failed` payload, so the terminal failure is self-describing without per-transport noise.
- **`failed` gained a bounded, throttled recovery path**: an eager server schedules a retry after `retry.cooldownMs` (default 60000; `0` means immediately) with no attempt ceiling, reusing `retry.cooldownMs`, which the schema accepted but nothing consumed. `startup: "manual"` and `"lazy"` servers keep the terminal state and must be reconnected explicitly. The timer is `unref()`-ed, is cleared by `connect`, `restart`, `disconnect`, `remove`, `invalidateHandle`, and `reset`, and defers while an interactive OAuth flow owns the server.
- **State transitions publish the existing `mcp.tools.changed` event.** Entering `needs_auth`, `needs_client_registration`, or `failed` changes the server's contribution to the tool surface, and the frontend already refreshes MCP status on that event, so no new event family or public contract was introduced.
- **A terminal failure notifies once per failure episode.** `mcp.failed` is published only when the episode has not been reported and the flag resets on success or an explicit reconnect, so a permanently offline server does not wake the frontend every cooldown.

`MCP.Status` keeps its existing members and field sets: `failed` carries a more accurate `error` string, which `status-presentation` already renders verbatim.

## Alternatives considered

- **Widen the supervisor's `instanceof` check to accept `InvalidGrantError` without implementing `invalidateCredentials`.** Rejected: the state would route to `needs_auth`, but the rejected credentials would remain on disk, and the credential check treats any stored refresh token as usable, producing a reconnect loop that never converges; `POST /mcp/:name/auth` would still fail 500 because its own `auth()` call cannot capture a redirect URL before throwing.
- **Add the cooldown retry without fixing credential invalidation.** Rejected: a revoked token would retry forever while re-authentication stayed broken, and the two failure classes — rejected credentials and transient transport faults — do not substitute for one another.
- **Sweep the auth store for unusable credentials at startup or on a timer.** Rejected: it reintroduces a second invalidation authority that must re-derive what `invalid_grant` means, and it cannot observe credentials revoked mid-session. The SDK already exposes the authoritative hook.
- **Add a `needs_reauth` status value.** Rejected: it widens the public contract — OpenAPI and SDK regeneration, a presentation tone, and messages in every locale — without carrying information that `needs_auth` lacks.
- **Keep `failed` terminal and ship observability only.** Rejected: transient causes such as VPN flaps, laptop sleep/wake, and remote 5xx would keep requiring manual intervention.
- **Implement `connect`/`restart` as in-process supervisor calls.** Rejected: the CLI would operate its own supervisor and exit, reporting success while the running server's handle was untouched.
- **Delete the unused `required` and `idleShutdownMs` fields in the same change.** Rejected: removal is a breaking change to the published plugin contract with no configuration migration available, since invalid configuration strips a whole `mcp` section. The fields are recorded under Consequences instead.

## Consequences

Re-authentication now works from the documented entry point without a manual credential delete, a revoked refresh token surfaces as actionable `needs_auth`, and a genuinely transient failure self-heals within one cooldown. Operator-facing text became more accurate and more exposed at once: the sanitized transport message reaches logs, `GET /mcp`, the `mcp.failed` event, and the Web UI. Because that string is a remote response body, the redaction contract had to grow with it — quoted key/value and bare-key query forms are now covered, so a server that reflects credentials in a JSON error body cannot persist them into the log file, the observability mirror, the HTTP response, or the settings panel. Every remaining failure that cannot be classified produces at most one WARN and one event per episode; an eager server that is permanently offline is retried roughly once per minute, a cost accepted in exchange for self-healing. `retry.cooldownMs` is now load-bearing rather than decorative, while two neighbouring fields remain accepted but unread: `required` and `idleShutdownMs` (the latter is still advertised as an MCP contribution policy in the plugin documentation), and `startup: "lazy"` remains behaviourally identical to `"manual"` because no on-demand start path exists — both are open follow-ups outside this change.

See [Isolate MCP OAuth ownership and harden observability](./2026-08-31-mcp-oauth-ownership-isolation.md) for the ownership boundary this change extends.
