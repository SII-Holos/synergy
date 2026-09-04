export type PushCapability =
  | { kind: "supported" }
  | { kind: "insecure-context" }
  | { kind: "no-service-worker" }
  | { kind: "no-push-manager" }
  | { kind: "ios-browser-tab" }

interface PushSubscriptionJSONLike {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface PushClient {
  getVapidKey(): Promise<{ publicKey: string }>
  subscribe(body: { endpoint: string; keys: { p256dh: string; auth: string }; deviceLabel?: string }): Promise<unknown>
  unsubscribe(body: { endpoint: string }): Promise<unknown>
}

export function pushCapability(): PushCapability {
  if (typeof window === "undefined") return { kind: "no-service-worker" }
  if (!window.isSecureContext) return { kind: "insecure-context" }
  if (!("serviceWorker" in navigator)) return { kind: "no-service-worker" }
  if (!("PushManager" in window)) return { kind: "no-push-manager" }
  // iOS exposes Push API only inside installed home-screen web apps; a plain
  // Safari tab reports a PushManager but never grants notification permission.
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone === true
  if (isIOS && !standalone) return { kind: "ios-browser-tab" }
  return { kind: "supported" }
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(normalized)
  const buffer = new ArrayBuffer(raw.length)
  const output = new Uint8Array(buffer)
  for (let index = 0; index < raw.length; index++) output[index] = raw.charCodeAt(index)
  return output
}

/**
 * Subscribe this device to Web Push. Must be called synchronously from a user
 * gesture handler: iOS only allows PushManager.subscribe inside the gesture's
 * event handler, and Notification.requestPermission needs a gesture too.
 */
export async function enableDevicePush(
  client: PushClient,
  input: { deviceLabel?: string } = {},
): Promise<PushSubscriptionJSONLike> {
  const permission = await Notification.requestPermission()
  if (permission !== "granted") throw new Error("Notification permission was not granted")

  const registration = await navigator.serviceWorker.register("/sw.js")
  await navigator.serviceWorker.ready

  const { publicKey } = await client.getVapidKey()
  const existing = await registration.pushManager.getSubscription()
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }))

  const json = subscription.toJSON() as Partial<PushSubscriptionJSONLike>
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("Push subscription is missing endpoint or encryption keys")
  }

  await client.subscribe({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    ...(input.deviceLabel !== undefined ? { deviceLabel: input.deviceLabel } : {}),
  })
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }
}

/** Remove this device's push subscription, both locally and on the server. */
export async function disableDevicePush(client: PushClient): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration("/sw.js")
  const subscription = await registration?.pushManager.getSubscription()
  if (subscription) {
    const json = subscription.toJSON() as Partial<PushSubscriptionJSONLike>
    if (json.endpoint) await client.unsubscribe({ endpoint: json.endpoint }).catch(() => undefined)
    await subscription.unsubscribe().catch(() => undefined)
  }
}
