// Synergy push service worker.
//
// Contract (iOS Web Push constraints, see docs/architecture/push.md):
// - A received push MUST immediately show a notification. Safari revokes the
//   site's notification permission when a push is handled silently:
//   https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
//   ("If your app receives a push that does not result in a notification,
//   that push is dropped and the system may revoke your app's permission")
//   and https://webkit.org/blog/14335/web-push-for-web-apps-on-iphone-and-ipad/
// - This worker never intercepts fetch: the app's asset negotiation and
//   release-update flow must stay untouched.
// - notificationclick focuses an existing window and asks it to navigate;
//   opening a deep-linked route directly is unreliable on iOS PWAs.

const FALLBACK_TITLE = "Synergy"
const FALLBACK_BODY = "You have a new notification"

self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("push", (event) => {
  let payload = null
  try {
    payload = event.data ? event.data.json() : null
  } catch {
    payload = null
  }

  const title = typeof payload?.title === "string" && payload.title ? payload.title : FALLBACK_TITLE
  const body = typeof payload?.body === "string" && payload.body ? payload.body : FALLBACK_BODY
  const tag = typeof payload?.tag === "string" && payload.tag ? payload.tag : "synergy-push"
  const href = typeof payload?.href === "string" && payload.href.startsWith("/") ? payload.href : "/"
  const badge = typeof payload?.badge === "number" && payload.badge > 0 ? payload.badge : 1

  // showNotification must run even for malformed payloads (silent-push ban).
  // Badge updates join the waitUntil chain: an untracked promise can be
  // dropped when the worker is terminated right after the notification work.
  const work = [self.registration.showNotification(title, { body, tag, data: { href } })]

  if ("setAppBadge" in self.navigator) {
    try {
      work.push(Promise.resolve(self.navigator.setAppBadge(badge)).catch(() => undefined))
    } catch {}
  }

  event.waitUntil(Promise.all(work))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()

  const href = (event.notification.data && event.notification.data.href) || "/"

  const work = [
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      for (const client of clientList) {
        try {
          await client.focus()
        } catch {}
        client.postMessage({ type: "push-navigate", href })
        return
      }
      await self.clients.openWindow(href)
    })(),
  ]

  if ("clearAppBadge" in self.navigator) {
    try {
      work.push(Promise.resolve(self.navigator.clearAppBadge()).catch(() => undefined))
    } catch {}
  }

  event.waitUntil(Promise.all(work))
})
