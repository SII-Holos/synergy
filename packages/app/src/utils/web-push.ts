import { assetPath } from "./proxy"

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

/** Thrown when the user denies (or the browser blocks) notification permission. */
export class PushPermissionDeniedError extends Error {
  constructor() {
    super("Notification permission was not granted")
    this.name = "PushPermissionDeniedError"
  }
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

function sameKey(a: Uint8Array<ArrayBuffer> | ArrayBuffer | null | undefined, b: Uint8Array<ArrayBuffer>): boolean {
  if (!a) return false
  const left = a instanceof Uint8Array ? a : new Uint8Array(a)
  if (left.length !== b.length) return false
  return left.every((value, index) => value === b[index])
}

/**
 * Subscribe this device to Web Push. Must be called synchronously from a user
 * gesture handler: iOS only allows PushManager.subscribe inside the gesture's
 * event handler, and Notification.requestPermission needs a gesture too.
 *
 * When the server's VAPID key rotated (vapid.json was regenerated), an
 * existing browser subscription is bound to the old application-server key and
 * must be recreated, otherwise push services reject deliveries signed with the
 * new key.
 */
export async function enableDevicePush(
  client: PushClient,
  input: { deviceLabel?: string } = {},
): Promise<PushSubscriptionJSONLike> {
  const permission = await Notification.requestPermission()
  if (permission !== "granted") throw new PushPermissionDeniedError()

  const registration = await navigator.serviceWorker.register(assetPath("/sw.js"))
  await navigator.serviceWorker.ready

  const { publicKey } = await client.getVapidKey()
  const applicationServerKey = urlBase64ToUint8Array(publicKey)

  let subscription = await registration.pushManager.getSubscription()
  if (subscription && !sameKey(subscription.options?.applicationServerKey, applicationServerKey)) {
    // VAPID key rotation: drop the stale local subscription so subscribe()
    // below binds to the current server key.
    await subscription.unsubscribe().catch(() => undefined)
    subscription = null
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  })

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
  // No-argument getRegistration() resolves the registration whose scope covers
  // the current page — the same one enableDevicePush created under any
  // reverse-proxy prefix.
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  if (subscription) {
    const json = subscription.toJSON() as Partial<PushSubscriptionJSONLike>
    if (json.endpoint) await client.unsubscribe({ endpoint: json.endpoint }).catch(() => undefined)
    await subscription.unsubscribe().catch(() => undefined)
  }
}
