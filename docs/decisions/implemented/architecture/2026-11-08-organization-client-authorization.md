# Decision Record: Organization client authorization

Status: implemented

## Problem

An organization browser login must support separately hosted Web clients and Desktop without depending on third-party cookies or giving a renderer a long-lived organization credential. Logout, account removal and password changes must invalidate access that was derived from that login, including after a service restart.

## Decision

The independent organization service owns a registered-client policy and authorization-code exchange. Each code binds an exact callback, issuer, organization, deployment incarnation, client configuration, current login and S256 proof. A first-party cookie and CSRF validation are required to authorize; access tokens cannot mint further codes. Exchange consumes the code and creates its grant and hashed tokens in one transaction. A lost successful response requires a fresh authorization rather than replaying a secret-bearing receipt.

The service's configuration schemas are owned by its optional component and shared by programmatic startup and the canonical global organization domain. Independent CLI commands read that file directly instead of invoking Agent configuration resolution; other domains, project configuration and environment/file interpolation cannot supply service policy. Invalid configuration remains intact and prevents service startup with a content-free diagnostic. The browser login lifetime is bounded to 30 days.

Web clients receive short-lived access tokens and no refresh token. Desktop receives a rotating refresh token tied to the original login's maximum lifetime. Reuse of an already-consumed refresh token commits revocation of that grant before returning the error; all access and refresh tokens derived from the grant then fail. Every authenticated API still checks the current login and account authentication revision, registered client and deployment identity. Changing or removing a registered client invalidates its existing grants and unconsumed codes.

Cross-origin API access allows only registered Web callback origins and the required request methods and headers. Preflight responses include the CSRF header only when the browser requested it, so discovery and token exchange do not advertise an unnecessary cookie-bound header. It does not grant cross-origin credentialed-cookie access. The service records only token digests and the PKCE challenge. The implementation cites the applicable PKCE and refresh-token guidance beside the exchange and rotation logic. Generated organization SDK methods expose discovery, authorization, exchange and refresh independently of the Runtime client.

The Web authorization and callback entry is built separately from the personal application shell. This keeps login usable without a personal Runtime and limits the document to its own assets and API. Each popup transaction owns its nonce, verifier, window and cancellation signal; the callback uses an exact target origin and clears its fragment before rendering. A registered client and the issuer/org/incarnation tuple are checked at discovery, callback and token acceptance. Web access remains in memory, and recovery after reload reuses the first-party cookie through an explicit new authorization.

Desktop keeps PKCE and access credentials in main memory and seals refresh credentials with the OS credential store. It durably marks a refresh attempt before sending it and only releases the replacement access token after its sealed refresh credential is saved. An interrupted attempt requires reauthorization. The original refresh digest remains usable only for idempotent login revocation, even when that token was consumed or its registered client was removed. Unknown tokens and client mismatches share the same success response. Offline logout persists a pending state that prevents all further local use and allows only explicit revocation retry. Login revocation leaves independently created logins intact.

The main-process bridge accepts a saved connection identity and a bounded JSON method/path request. It adds credentials only after validating the actual App main frame, document generation and explicit route allowlist. It preserves structured API errors without retrying a business write. Renderer navigation and logout abort pending work, and the callback handler consumes native authorization links before ordinary deep-link delivery. The shared atomic writer uses portable Node filesystem operations so the same durable promotion runs in Electron without a Bun global.

## Alternatives considered

**Long-lived browser bearer tokens.** Persistent browser storage would expand credential exposure and complicate immediate logout. The first-party login remains the source for subsequent Web authorization.

**Self-contained access tokens validated without durable state.** This would delay account and login revocation until token expiry. The service already owns transactional authentication state, so opaque tokens preserve immediate checks.

**Returning a previous refresh result on retry.** Recovering that result would require retaining bearer secrets or permitting ambiguous token reuse. Refresh tokens rotate once; replay invalidates the grant and requires sign-in recovery.

**Loading the full Runtime configuration for the service.** That would introduce unrelated owner discovery, reference expansion and migration writes into a process that does not execute Agents. A narrowly scoped reader uses the existing domain filename and owning schema without starting that lifecycle.

**Using the personal application bootstrap for authorization.** Personal server health, plugins and service-worker lifecycle are unrelated to organization login. A separate built document reuses the existing locale, theme and control components without starting that application tree.

**Refreshing first to recover logout authority.** A lost successful refresh response makes that replay unsafe. Revocation accepts possession of the old refresh credential and can only remove authority, so it needs neither a fresh access token nor a stored secret-bearing server receipt.

**Deleting local credentials before an offline logout completes.** That loses the proof needed to revoke the server login. A sealed, unusable pending record retains only the ability to retry revocation and cannot silently reconnect.

## Consequences

Authentication adds a durable lookup to each API request. Refresh callers must serialize rotation, and a lost refresh response can require reauthorization. New code and token record collections use their own versioned schemas without changing existing login records. Desktop introduces versioned, encrypted account records under its own application data directory; existing personal credentials do not migrate into them. Real-service tests cover concurrency, account revocation, expiry, exact origins and callbacks, restart, client-policy changes, hashed persistence and the generated SDK over HTTP. Browser tests cover Web recovery and callback isolation; native client tests cover encrypted persistence, rotation uncertainty, logout races, frame trust and document cancellation. Space selection and member Runtime supervision remain separate integration work.
