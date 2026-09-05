# Decision Record: Push VAPID subject must be a publicly resolvable URI

Status: implemented

## Problem

Every push delivery to Apple failed with `403 {"reason":"BadJwtToken"}` from `web.push.apple.com` — no iOS device received a notification through the Web Push path introduced in #1315, while the stored subscriptions, the VAPID key pair, and the Bun runtime were all healthy. Holding the key and subscription constant isolated the failing variable: the VAPID JWT `sub` claim was `mailto:synergy@localhost`, and Apple resolves the subject host before accepting the token. RFC 8292 requires a contactable `mailto:` or `https:` URI; a `localhost` host is not resolvable, so Apple rejects the whole JWT. Desktop push services (FCM, Mozilla) accept such subjects, which is why the defect only surfaced on iOS home-screen web apps.

## Decision

`PushService` now signs every VAPID JWT with `subject: "https://github.com/SII-Holos/synergy"` — the project's public repository URL, ownership-equivalent to a contact address and verified to deliver (`201`) with the existing VAPID key and subscriptions. Delivery-failure warnings now include the push endpoint's HTTP status code, so endpoint rejections are diagnosable from logs alone. No key rotation and no device re-subscription: a subscription binds to the application server key, not to the subject claim.

## Alternatives considered

- **Rotating the VAPID key pair** — rejected: a fresh key pair with the same `localhost` subject still returned `403 BadJwtToken`, while the existing key with a resolvable subject delivered `201`; the key was never the failing variable, and rotation would have forced every device to re-subscribe.
- **Asking devices to re-subscribe** — rejected for the same reason: re-subscription refreshes the endpoint and encryption keys but cannot change the server-side subject; the two stored subscriptions were proven deliverable as-is.
- **A real-domain `mailto:` address** — viable in principle (RFC 8292 accepts mailto URIs), but the repository has no canonical contact mailbox whose resolvability is guaranteed; the public project URL is already owned, stable, and verified.

## Consequences

iOS Web Push deliveries work again with the existing VAPID key pair and subscriptions; running instances pick the fix up on restart. Delivery failures now surface their HTTP status in logs. The subject is a constant in `packages/synergy/src/push/service.ts`: if the project URL moves, that constant must move with it, and any future value must remain a publicly resolvable URI — the failure mode is silent except for endpoint warnings. The strictness is Apple-specific; other push services tolerate looser subjects, so a regression here would again only affect Apple endpoints.
