# Decision Record: Organization client authorization

Status: implemented

## Problem

An organization browser login must support separately hosted Web clients and Desktop without depending on third-party cookies or giving a renderer a long-lived organization credential. Logout, account removal and password changes must invalidate access that was derived from that login, including after a service restart.

## Decision

The independent organization service owns a registered-client policy and authorization-code exchange. Each code binds an exact callback, issuer, organization, deployment incarnation, client configuration, current login and S256 proof. A first-party cookie and CSRF validation are required to authorize; access tokens cannot mint further codes. Exchange consumes the code and creates its grant and hashed tokens in one transaction. A lost successful response requires a fresh authorization rather than replaying a secret-bearing receipt.

The service's configuration schemas are owned by its optional component and shared by programmatic startup and the canonical global organization domain. Independent CLI commands read that file directly instead of invoking Agent configuration resolution; other domains, project configuration and environment/file interpolation cannot supply service policy. Invalid configuration remains intact and prevents service startup with a content-free diagnostic. The browser login lifetime is bounded to 30 days.

Web clients receive short-lived access tokens and no refresh token. Desktop receives a rotating refresh token tied to the original login's maximum lifetime. Reuse of an already-consumed refresh token commits revocation of that grant before returning the error; all access and refresh tokens derived from the grant then fail. Every authenticated API still checks the current login and account authentication revision, registered client and deployment identity. Changing or removing a registered client invalidates its existing grants and unconsumed codes.

Cross-origin API access allows only registered Web callback origins and the required request methods and headers. It does not grant cross-origin credentialed-cookie access. The service records only token digests and the PKCE challenge. The implementation cites the applicable PKCE and refresh-token guidance beside the exchange and rotation logic. Generated organization SDK methods expose discovery, authorization, exchange and refresh independently of the Runtime client.

## Alternatives considered

**Long-lived browser bearer tokens.** Persistent browser storage would expand credential exposure and complicate immediate logout. The first-party login remains the source for subsequent Web authorization.

**Self-contained access tokens validated without durable state.** This would delay account and login revocation until token expiry. The service already owns transactional authentication state, so opaque tokens preserve immediate checks.

**Returning a previous refresh result on retry.** Recovering that result would require retaining bearer secrets or permitting ambiguous token reuse. Refresh tokens rotate once; replay invalidates the grant and requires sign-in recovery.

**Loading the full Runtime configuration for the service.** That would introduce unrelated owner discovery, reference expansion and migration writes into a process that does not execute Agents. A narrowly scoped reader uses the existing domain filename and owning schema without starting that lifecycle.

## Consequences

Authentication adds a durable lookup to each API request. Refresh callers must serialize rotation, and a lost refresh response can require reauthorization. New code and token record collections use their own versioned schemas without changing existing login records. Real-service tests cover concurrency, account revocation, expiry, exact origins and callbacks, restart, client-policy changes, hashed persistence and the generated SDK over HTTP. This service change does not itself supply the Web authorization window, callback transaction state, Desktop credential storage or space selection.
