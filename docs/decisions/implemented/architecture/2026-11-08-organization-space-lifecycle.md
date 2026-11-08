# Decision Record: Organization space connection lifecycle

Status: implemented

## Problem

Organization selection must remain available when the personal Runtime is offline. URL-based routing alone cannot distinguish accounts or restored deployments, and a retained component can continue using its previous client after its heading changes. Logout can also become uncertain after a lost response or credential expiry.

## Decision

A shared SpaceContext surrounds separate personal and organization business views. The existing space menu exposes verified account descriptions, connection recovery and project selection. Organization routes include organization, account and deployment incarnation. Each selected view owns a new cancellation generation and a keyed component/dialog lifetime. Project lists and details use generated organization APIs and validate their returned ownership; they do not synthesize personal Runtime capabilities.

Web persists only versioned public connection descriptions. In-memory access credentials and native main-process authority remain separate. Returning to another account cancels old requests before constructing its client. Existing-account recovery checks the full expected identity; connecting a different account uses the explicit new-connection flow. The Web server publishes exact global HTTPS connection origins into both its CSP and boot document, including direct document requests. Project settings cannot relax this policy.

Explicit logout first blocks local business use and removes controlled identity-owned caches. A failed request remains pending until explicit retry succeeds; a new connection to the same account cannot replace that pending state. The service accepts expired or revoked access proof solely to revoke its original login, preserving origin and deployment binding. This makes retries safe without issuing a new grant or password prompt. If the browser has already lost the proof, an explicit authorization window is required to finish logout for the same account. Native logout continues through its existing durable revocation owner.

## Alternatives considered

**Keep all views inside personal bootstrap.** A failed personal connection would prevent organization access and retain unrelated business providers.

**Change only the active URL or visible headings.** Captured clients, dialogs and asynchronous replies would survive account changes. Real browser testing reproduced a retained project component until the keyed callback established a new owner.

**Persist browser access or refresh credentials.** Public descriptors are enough to recover the selected identity; long-lived browser credentials are unnecessary for first-party authorization recovery.

**Authenticate expired logout proof as ordinary access.** It would either prevent logout recovery or reopen business access. A revocation-only path preserves the distinction.

## Consequences

Personal usage remains independent of organization login. Web authorization requires administrator configuration on both origins, and browser restrictions require an explicit recovery gesture. Unknown browser record versions are preserved and prevent overwriting that record. Account names can be restored before authority, but project contents cannot.

Tests cover actual App startup with an offline personal service, A/B switching with held project responses, native descriptor validation, project deep links and refresh, narrow keyboard navigation, memory-only Web credentials, cancellation, corrupt persisted records, pending logout, expiry and server restart. Real HTTPS browser acceptance also covers the complete App, the independent organization service, first-party authorization recovery and explicit logout across refresh.

The SpaceContext wrapper, project presentation and static message descriptors have individual coverage-manifest entries naming these browser tests. Chromium execution is outside Bun LCOV; connection and route state retain direct measurement, and package coverage thresholds remain unchanged.
