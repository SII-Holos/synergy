# Web Push notifications

Web Push gives Synergy Web a delivery surface that works while the app is closed or backgrounded, most importantly for an iPhone home-screen PWA. The server subscribes to session lifecycle events, filters them, and fans out encrypted notifications per device through the standard VAPID/Web Push chain (Apple Push Notification service, Firebase Cloud Messaging, or Mozilla autopush). The browser's service worker is the only component that may present a notification while no page is visible, so this path complements — and on iOS replaces — the page-context `new Notification()` calls the frontend uses on desktop.

The chain is deliberately additive: it stores data under `data/push/`, adds one HTTP route group, and requires no configuration file, schema migration, or provider credentials. Deleting `data/push/` and dropping the service-worker registration stops it with no other state to unwind.

## Ownership

`packages/synergy/src/push/` owns the whole server side and is wired into the runtime in `GlobalRuntime.start()` (immediately after `startChannels()`) via `PushBridge.init()`, which returns a dispose function. The delivery chain:

1. **Event bridge** (`bridge.ts`) — subscribes to four global bus events and turns them into push payloads:
   - `SessionEvent.Completion` → "Response ready", `badge` = unread count.
   - `SessionEvent.Error` → "Session error"; without a resolvable session it falls back to the scope root `href` (`/` + base64(scope token)) with tag `session-global`.
   - `Question.Event.Asked` and `PermissionNext.Event.Asked` → "Session needs your input".
2. **Filtering** (`bridge.ts` `skip()`) — a session whose endpoint is a channel is always skipped: channel sessions already deliver through their own outbound/question-card surface. Completion and error additionally skip child sessions (`parentID` set), mirroring the Web app's `notification-event.ts` rules; input never skips child sessions, because a permission or question prompt on a delegated task still needs the human. A session that cannot be resolved is skipped silently (error events without a session ID are the exception above).
3. **Per-device fan-out** (`service.ts`) — `PushService.send` loads every subscription, keeps those opted into the payload's category (the `test` category always matches), and delivers to each with `Promise.allSettled`. A 404/410 response prunes that subscription; any other transport error is logged and never propagates, so a broken device cannot block other devices or the event publisher. The send function is injectable (`setSender`/`resetSender`) as a test seam, and `PushBridge.flush()` awaits all in-flight fan-outs so tests and shutdown are deterministic.

TTL and urgency vary by category: `input` uses 3600 s / high; `completion`, `error`, and `test` use 300 s / normal.

### Payload contract

The payload is JSON with `title`, `body`, `href`, `tag`, `category`, and optional `badge`:

- `body` — session title, truncated to 200 characters (ellipsis).
- `href` — the same route contract as the Web app's notification events: `/${base64Encode(scopeToken)}/session/${sessionID}` where the token is the literal `home` for the home scope and the scope directory otherwise.
- `tag` — `session-${sessionID}` for completion/error and `input-${sessionID}` for input, matching the tag the Web app passes to desktop page notifications (`platform.notify(..., tag)`), so both surfaces collapse into one notification per session.
- `badge` — only on completion; the unread count for that session.

## Storage layout

All state lives under the data home (`Global.Path.data`):

| Path                           | Content                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push/subscriptions/<id>.json` | One subscription per registered device: `endpoint`, `keys` (`p256dh`/`auth`), optional `deviceLabel`, `created`, per-category toggles. Upserted idempotently by endpoint; re-subscribing refreshes keys instead of duplicating.             |
| `push/vapid.json`              | VAPID key pair, generated on first use. The private key is a credential: never logged, never exported, never returned by any route. Deleting the file regenerates the pair and invalidates existing subscriptions (devices must re-enable). |

## HTTP routes

`PushRoute` (`packages/synergy/src/server/push.ts`) mounts at `/push` on the server's authenticated global route chain, inheriting its auth and request-scope middleware. OpenAPI metadata feeds the regenerated SDK.

| Method | Path                                 | OperationId             | Behavior                                                                                                               |
| ------ | ------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET    | `/push/vapid-key`                    | `push.getVapidKey`      | Returns the public VAPID key browsers pass to `pushManager.subscribe`.                                                 |
| GET    | `/push/subscriptions`                | `push.list`             | Lists registered subscriptions (id, endpoint, optional label, created, categories); transport keys are never returned. |
| POST   | `/push/subscribe`                    | `push.subscribe`        | Registers a subscription; idempotent per endpoint. Rejects endpoints outside the push-service allowlist.               |
| POST   | `/push/unsubscribe`                  | `push.unsubscribe`      | Removes a subscription by endpoint; idempotent.                                                                        |
| POST   | `/push/test`                         | `push.test`             | Sends a test-category notification to one endpoint (404 if unknown) or to every subscription.                          |
| PATCH  | `/push/subscriptions/:id/categories` | `push.updateCategories` | Updates one subscription's completion/error/input toggles; unknown id returns 404.                                     |

**SSRF boundary** — `subscribe`/`unsubscribe`/`test` validate the endpoint against `isAllowedPushEndpoint()` (`packages/synergy/src/push/types.ts`): only `https:` URLs whose host is `*.push.apple.com`, `fcm.googleapis.com`, or `updates.push.services.mozilla.com` are accepted. Push endpoints are attacker-controllable URLs that the server later POSTs to, so this allowlist is the security boundary of the route group.

## Service worker contract

`packages/app/public/sw.js` is a plain-JavaScript service worker with no build step, registered by `entry.tsx` only in secure contexts with service-worker support (registration failure is silent). It enforces four constraints:

- **A received push must immediately call `showNotification`** — Safari revokes notification permission when a push is handled silently, so even a malformed or missing payload shows a fallback ("Synergy" / "You have a new notification"). There is no notification-dedup or quiet-mode branch in the worker.
- **No fetch handler** — the worker never intercepts `fetch`, protecting the app's asset negotiation and release-update mechanism. Payload validation is minimal and defensive (`href` must start with `/`), never a reason to drop a notification.
- **App badge** — `setAppBadge` on push and `clearAppBadge` on click, both wrapped in try/catch (not every platform exposes `navigator.setAppBadge`).
- **Click navigates through the SPA** — `notificationclick` closes the notification, focuses an existing window if one is found, and posts `{type: "push-navigate", href}`; `entry.tsx` listens and routes via `history.pushState` + `popstate`. `openWindow(href)` is the fallback when no window client exists. The worker also calls `skipWaiting()` on install and `clients.claim()` on activate.

## Client enablement

The settings General panel exposes the device-push state and actions; the subscribe flow lives in `packages/app/src/utils/web-push.ts`:

- **Capability probe** (`pushCapability`) — distinguishes insecure context, missing service worker/PushManager, and an iOS Safari _tab_ (iOS exposes the Push API only inside an installed home-screen web app), so the UI can explain why Enable is unavailable.
- **Enable** (`enableDevicePush`) — must run inside the user-gesture handler: `Notification.requestPermission()`, then `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` with the VAPID key fetched from `/push/vapid-key`, then POST the resulting endpoint/keys to `/push/subscribe`. An existing local subscription is reused rather than recreated.
- **Disable** (`disableDevicePush`) — unsubscribes locally and removes the server record by endpoint.
- The panel lists devices (label, per-category switches, Remove) through `push.list` / `push.updateCategories` / `push.test`, reusing the SDK's generated client.

Desktop page notifications are unchanged and now pass the same `tag` (`session-${sessionID}`) as push deliveries, so the two surfaces collapse duplicates instead of double-notifying.

## Operating notes: iOS Web Push limitations

These are platform constraints v1 accepts rather than engineers around:

- **Only installed home-screen web apps receive pushes** (iOS ≥ 16.4, Web Push in Safari). A plain Safari tab cannot subscribe.
- **Silent pushes are forbidden** — the service worker must show every received push; handling one silently gets the site's permission revoked. Hence the unconditional `showNotification` in `sw.js`.
- **Subscription must start in a user gesture** — `Notification.requestPermission()` and `pushManager.subscribe()` must be called synchronously inside the tap handler; the Enable button does exactly this.
- **No notification action buttons**, and `notificationclick` can only reliably bring the app to the foreground — deep links are performed by the SPA after the worker's `push-navigate` message.
- **Swiping the PWA away from the app switcher may stop pushes** (known iOS behavior, per Apple documentation); the notification permission and service worker survive, but delivery can pause until the app is opened again.
- **Background-page JavaScript is frozen** — on iOS a home-screen PWA does not run page JS in the background, which is precisely why the page-context notification path never worked there and why presentation is delegated to the service worker.

## Prerequisites: HTTPS via tailscale serve

Web Push requires a secure context plus a service worker, and iOS requires the site to be installed from HTTPS. `tailscale serve` (or equivalent) exposing Synergy Web as `https://<machine>.<tailnet>.ts.net` satisfies this with a Let's Encrypt certificate, and the origin is stable across devices on the tailnet. The route group and client probe inherit the same origin, so no CORS or extra configuration is needed. Without HTTPS the capability probe reports `insecure-context` and the UI offers no Enable action.

## Rollback

The feature is purely incremental:

1. Delete `data/push/` (subscriptions + VAPID keys). With no subscriptions, `PushService.send` returns immediately and the bridge is a no-op observer.
2. Remove the service-worker registration from `entry.tsx` (a stale worker without fetch handling is also harmless, but removing it ends push delivery).
3. Nothing else changes: no config migration, no schema version, no persisted flags.
