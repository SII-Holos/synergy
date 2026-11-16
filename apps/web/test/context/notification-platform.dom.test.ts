import { expect, test } from "bun:test"
import { notifyBrowser } from "../../src/context/notification-platform"

async function fixture(
  body: (input: {
    notifications: Array<{ onclick?: () => void; closed: boolean }>
    permission(value: NotificationPermission | Promise<NotificationPermission>): void
    navigations: string[]
  }) => Promise<void>,
) {
  const properties = [
    { owner: globalThis, key: "Notification", descriptor: Object.getOwnPropertyDescriptor(globalThis, "Notification") },
    { owner: window, key: "Notification", descriptor: Object.getOwnPropertyDescriptor(window, "Notification") },
    {
      owner: document,
      key: "visibilityState",
      descriptor: Object.getOwnPropertyDescriptor(document, "visibilityState"),
    },
    { owner: window, key: "focus", descriptor: Object.getOwnPropertyDescriptor(window, "focus") },
    {
      owner: window.history,
      key: "pushState",
      descriptor: Object.getOwnPropertyDescriptor(window.history, "pushState"),
    },
  ]
  const notifications: Array<{ onclick?: () => void; closed: boolean }> = []
  const navigations: string[] = []
  let permission: NotificationPermission | Promise<NotificationPermission> = "granted"
  class Notice {
    static permission = "default"
    static async requestPermission() {
      return permission
    }
    onclick?: () => void
    closed = false
    constructor() {
      notifications.push(this)
    }
    close() {
      this.closed = true
    }
  }
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: Notice })
  Object.defineProperty(window, "Notification", { configurable: true, value: Notice })
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
  Object.defineProperty(window, "focus", { configurable: true, value() {} })
  Object.defineProperty(window.history, "pushState", {
    configurable: true,
    value(_data: unknown, _title: string, href: string) {
      navigations.push(href)
    },
  })
  try {
    await body({
      notifications,
      navigations,
      permission(value) {
        permission = value
      },
    })
  } finally {
    for (const property of properties.reverse()) {
      if (property.descriptor) Object.defineProperty(property.owner, property.key, property.descriptor)
      else Reflect.deleteProperty(property.owner, property.key)
    }
  }
}

test("a held browser permission cannot publish an old notification after its source retires", async () => {
  await fixture(async (f) => {
    const permission = Promise.withResolvers<NotificationPermission>()
    f.permission(permission.promise)
    let current = true
    const pending = notifyBrowser("Old source", "Metadata", "/fallback", "tag", {
      current: () => current,
      activate() {},
    })
    current = false
    permission.resolve("granted")
    await pending
    expect(f.notifications).toHaveLength(0)
    expect(f.navigations).toEqual([])
  })
})

test("notification click rechecks its original activation and never falls back to href when invalid", async () => {
  await fixture(async (f) => {
    let current = true
    let activated = 0
    await notifyBrowser("Source", "Metadata", "/fallback", "tag", {
      current: () => current,
      activate() {
        activated++
      },
    })
    expect(f.notifications).toHaveLength(1)
    current = false
    f.notifications[0].onclick?.()
    expect(activated).toBe(0)
    expect(f.navigations).toEqual([])
    expect(f.notifications[0].closed).toBe(true)
  })
})

test("legacy notifications without an activation retain their original href path", async () => {
  await fixture(async (f) => {
    await notifyBrowser("Legacy", "Metadata", "/original/session", "tag")
    f.notifications[0].onclick?.()
    expect(f.navigations).toEqual(["/original/session"])
    expect(f.notifications[0].closed).toBe(true)
  })
})
