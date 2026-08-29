# Decision Record: Validate Holos endpoint configuration and agent path parameters

Status: implemented

## Problem

The Clarus base-path work routed credential-bearing flows — bind code exchange, credential verification, profile fetches, browser-opened portal pages — through the `holos.*` config domain and Clarus `apiUrl`, but the `Holos` domain itself accepted arbitrary strings. Remote well-known config merged as the base layer could redirect the agent secret and the bind flow to an attacker host, and non-loopback plaintext HTTP was accepted. Base URLs containing an `api` path segment also produced divergent request paths between Synergy's `HolosEndpoint.url` joining and the Holos CLI's `normalizeApiBaseUrl`, so one config value could serve only one of the two clients. The `/agents/:agentId` route interpolated an unvalidated path parameter into the upstream URL with the caller's bearer token attached.

## Decision

`validateHolosEndpoint` rejects base URLs whose path contains an `api` segment, keeping Synergy REST/WS and Holos CLI preflight path joining aligned on origin-plus-prefix bases. The `Holos` config domain validates `apiUrl` and `wsUrl` with `validateHolosEndpoint` and `portalUrl` with a new `validateHolosPortalUrl` that permits HTTPS everywhere and HTTP on loopback only, without query or fragment. The `/agents/:agentId` route parameter is constrained to a URL-safe character set without dot segments and is percent-encoded when interpolated into the upstream path.

## Alternatives considered

**Validate only in `HolosEndpoint.resolve()` with fallback to defaults** — rejected because a silent fallback would mask hostile config changes and the CLI runner still receives the raw configured value, so the two sides would diverge behind the fallback.

**Port the CLI's suffix-aware normalization into Synergy** — rejected because two joining implementations would keep drifting; rejecting ambiguous bases at config load fails closed with one actionable message.

**Allow `api`-prefixed bases and normalize both sides** — rejected because it preserves a compatibility surface for exactly the values that already produce different upstream paths in the two clients.

## Consequences

Config values containing `api` path segments, non-loopback plaintext HTTP, credentials in the URL, or query/fragment now fail validation at load and quarantine like other domain errors, falling back to the last-good or default endpoints. Defaults and previously valid origin/prefix bases are unaffected. Agent detail requests reject malformed IDs with 400 instead of probing upstream paths.
