import { subscribeOrganizationNotifications, type OrganizationNotificationFailure } from "./notification-subscription"
import type { OrganizationNotificationProtocol as Notification } from "@ericsanchezok/synergy-organization-protocol"

type Subscription = Parameters<typeof subscribeOrganizationNotifications>[0]
type Capture = Pick<Subscription, "audience" | "source" | "current"> & { expiresAt?: number }
export type OrganizationNotificationSource = { readonly audience: Notification.Audience; current(): boolean }
type Listener = (notice: Notification.Observation, owner: OrganizationNotificationSource) => void | Promise<void>
type Record = { listeners: Set<Listener>; active?: { current(): boolean; dispose(): void } }

export function createOrganizationNotificationSources(input: {
  capture(key: string): Capture | undefined
  unauthorized(key: string): void
}) {
  const capture = input.capture
  const unauthorized = input.unauthorized
  const records = new Map<string, Record>()
  let disposed = false
  function start(key: string, record: Record) {
    const source = capture(key)
    if (!source) return
    if (source.expiresAt !== undefined && source.expiresAt <= Date.now()) {
      unauthorized(key)
      return
    }
    const controller = new AbortController()
    let subscription: ReturnType<typeof subscribeOrganizationNotifications> | undefined
    let expiration: ReturnType<typeof setTimeout> | undefined
    const owns = () => !disposed && !controller.signal.aborted && records.get(key) === record && source.current()
    const current = () => owns() && (source.expiresAt === undefined || source.expiresAt > Date.now())
    const owner = Object.freeze({ audience: Object.freeze({ ...source.audience }), current })
    const dispose = () => {
      controller.abort()
      clearTimeout(expiration)
      subscription?.dispose()
    }
    record.active = { current, dispose }
    if (source.expiresAt !== undefined)
      expiration = setTimeout(
        () => {
          if (owns()) unauthorized(key)
          dispose()
        },
        Math.min(2_147_483_647, Math.max(0, source.expiresAt - Date.now())),
      )
    const pause = (milliseconds: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          controller.signal.removeEventListener("abort", done)
          resolve()
        }
        const timer = setTimeout(done, milliseconds)
        controller.signal.addEventListener("abort", done, { once: true })
        if (controller.signal.aborted) done()
      })
    void (async () => {
      let delay = 1000
      while (current()) {
        let failure: OrganizationNotificationFailure | undefined
        subscription = subscribeOrganizationNotifications({
          ...source,
          current,
          async receive(notice) {
            for (const listener of [...record.listeners]) {
              if (!current()) return
              if (!record.listeners.has(listener)) continue
              await listener(structuredClone(notice), owner)
            }
          },
          failed(error) {
            failure = error
          },
        })
        await subscription.closed
        if (!current()) break
        if (
          failure &&
          [
            "reauthorization_required",
            "signed_out",
            "connection_changed",
            "identity_changed",
            "permission_denied",
          ].includes(failure.code)
        ) {
          unauthorized(key)
          break
        }
        if (failure?.code === "bridge_incompatible") break
        await pause(delay)
        delay = Math.min(delay * 2, 30_000)
      }
    })().catch(() => dispose())
  }
  return {
    subscribe(key: string, listener: Listener) {
      if (disposed) return () => {}
      let record = records.get(key)
      if (!record) {
        record = { listeners: new Set() }
        records.set(key, record)
      }
      record.listeners.add(listener)
      if (!record.active?.current()) {
        record.active?.dispose()
        start(key, record)
      }
      const owned = record
      return () => {
        owned.listeners.delete(listener)
        if (owned.listeners.size || records.get(key) !== owned) return
        records.delete(key)
        owned.active?.dispose()
      }
    },
    refresh() {
      if (disposed) return
      for (const [key, record] of records) {
        if (record.active?.current()) continue
        record.active?.dispose()
        record.active = undefined
        start(key, record)
      }
    },
    dispose() {
      disposed = true
      for (const record of records.values()) record.active?.dispose()
      records.clear()
    },
  }
}
