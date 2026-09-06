import path from "node:path"
import fs from "node:fs/promises"
import { afterEach, describe, expect, test } from "bun:test"
import { PushService } from "../../src/push/service"
import { PushStore } from "../../src/push/store"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { tmpdir } from "../fixture/fixture"

type SentCall = {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
  payload: string
  options: { TTL?: number; urgency?: string; vapidDetails?: { publicKey: string; privateKey: string; subject: string } }
}

const APPLE = "https://web.push.apple.com/push/v1/device-a"
const FCM = "https://fcm.googleapis.com/fcm/send/device-b"

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir()
  const previous = process.env.SYNERGY_TEST_HOME
  const home = path.join(tmp.path, "home")
  process.env.SYNERGY_TEST_HOME = home
  await fs.mkdir(home, { recursive: true })
  try {
    return await ScopeContext.provide({ scope: Scope.home(), fn })
  } finally {
    if (previous === undefined) delete process.env.SYNERGY_TEST_HOME
    else process.env.SYNERGY_TEST_HOME = previous
  }
}

function recordingSender(behavior: (endpoint: string) => { status: number } | undefined = () => undefined) {
  const calls: SentCall[] = []
  const send = ((subscription: any, payload: any, options: any) => {
    calls.push({ subscription, payload, options })
    const result = behavior(subscription.endpoint)
    if (result) {
      const error = new Error("push endpoint rejected") as any
      error.statusCode = result.status
      return Promise.reject(error)
    }
    return Promise.resolve({ statusCode: 201 } as any)
  }) as any
  return { calls, send }
}

afterEach(() => {
  PushService.resetSender()
})

describe("PushService.send", () => {
  test("sends nothing when there are no subscriptions", async () => {
    await withIsolatedHome(async () => {
      const { calls, send } = recordingSender()
      PushService.setSender(send)
      await PushService.send({
        title: "Response ready",
        body: "s",
        href: "/x",
        tag: "t",
        category: "completion",
      })
      expect(calls).toHaveLength(0)
    })
  })

  test("fans out to all devices with per-category TTL/urgency", async () => {
    await withIsolatedHome(async () => {
      await PushStore.upsert({ endpoint: APPLE, keys: { p256dh: "a", auth: "b" } })
      await PushStore.upsert({ endpoint: FCM, keys: { p256dh: "c", auth: "d" } })
      const { calls, send } = recordingSender()
      PushService.setSender(send)

      await PushService.send({
        title: "Session needs your input",
        body: "s",
        href: "/x",
        tag: "input-1",
        category: "input",
      })
      expect(calls).toHaveLength(2)
      for (const call of calls) {
        expect(call.options.TTL).toBe(3600)
        expect(call.options.urgency).toBe("high")
        const payload = JSON.parse(call.payload)
        expect(payload.category).toBe("input")
        expect(payload.title).toBe("Session needs your input")
        expect(call.options.vapidDetails!.publicKey).toBeTruthy()
        expect(call.options.vapidDetails!.privateKey).toBeTruthy()
        expect(call.options.vapidDetails!.subject).toBe("https://github.com/SII-Holos/synergy")
      }

      await PushService.send({
        title: "Response ready",
        body: "s",
        href: "/x",
        tag: "session-1",
        category: "completion",
        badge: 3,
      })
      const completionCall = calls.find((c) => c.payload.includes("completion"))!
      expect(completionCall.options.TTL).toBe(300)
      expect(completionCall.options.urgency).toBe("normal")
      expect(JSON.parse(completionCall.payload).badge).toBe(3)
    })
  })

  test("filters by per-subscription categories", async () => {
    await withIsolatedHome(async () => {
      await PushStore.upsert({ endpoint: APPLE, keys: { p256dh: "a", auth: "b" } })
      await PushStore.upsert({
        endpoint: FCM,
        keys: { p256dh: "c", auth: "d" },
        categories: { completion: false, error: true, input: false },
      })
      const { calls, send } = recordingSender()
      PushService.setSender(send)

      await PushService.send({
        title: "Response ready",
        body: "s",
        href: "/x",
        tag: "session-1",
        category: "completion",
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.subscription.endpoint).toBe(APPLE)

      calls.length = 0
      await PushService.send({ title: "T", body: "s", href: "/x", tag: "push-test", category: "test" })
      expect(calls).toHaveLength(2)
    })
  })

  test("prunes subscription on 410 and keeps other devices delivering", async () => {
    await withIsolatedHome(async () => {
      const stale = await PushStore.upsert({ endpoint: APPLE, keys: { p256dh: "a", auth: "b" } })
      await PushStore.upsert({ endpoint: FCM, keys: { p256dh: "c", auth: "d" } })
      const { calls, send } = recordingSender((endpoint) => (endpoint === APPLE ? { status: 410 } : undefined))
      PushService.setSender(send)

      await PushService.send({ title: "T", body: "s", href: "/x", tag: "t", category: "error" })
      expect(calls).toHaveLength(2)

      const remaining = await PushStore.list()
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.id).not.toBe(stale.id)

      calls.length = 0
      await PushService.send({ title: "T", body: "s", href: "/x", tag: "t", category: "error" })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.subscription.endpoint).toBe(FCM)
    })
  })

  test("non-410 endpoint errors never propagate and never prune", async () => {
    await withIsolatedHome(async () => {
      const sub = await PushStore.upsert({ endpoint: APPLE, keys: { p256dh: "a", auth: "b" } })
      const { send } = recordingSender(() => ({ status: 500 }))
      PushService.setSender(send)

      await PushService.send({ title: "T", body: "s", href: "/x", tag: "t", category: "error" })
      const remaining = await PushStore.list()
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.id).toBe(sub.id)
    })
  })
})
