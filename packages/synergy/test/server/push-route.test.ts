import path from "node:path"
import fs from "node:fs/promises"
import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { PushRoute } from "../../src/server/push"
import { PushService } from "../../src/push/service"
import { PushStore } from "../../src/push/store"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { tmpdir } from "../fixture/fixture"

const APPLE = "https://web.push.apple.com/push/v1/device-a"
const FCM = "https://fcm.googleapis.com/fcm/send/device-b"

function app() {
  return new Hono().route("/push", PushRoute)
}

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

afterEach(() => {
  PushService.resetSender()
})

describe("PushRoute", () => {
  test("GET /push/vapid-key returns a generated public key", async () => {
    await withIsolatedHome(async () => {
      const response = await app().request("/push/vapid-key")
      expect(response.status).toBe(200)
      const body = (await response.json()) as { publicKey: string }
      expect(body.publicKey).toBeTruthy()
    })
  })

  test("subscribe rejects non-push-service endpoints (SSRF boundary)", async () => {
    await withIsolatedHome(async () => {
      const response = await app().request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: "https://evil.example.com/push",
          keys: { p256dh: "a", auth: "b" },
        }),
      })
      expect(response.status).toBe(400)
      expect(await PushStore.list()).toHaveLength(0)
    })
  })

  test("subscribe is idempotent by endpoint and never returns keys", async () => {
    await withIsolatedHome(async () => {
      const request = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: APPLE,
          keys: { p256dh: "a", auth: "b" },
          deviceLabel: "iPhone",
        }),
      } as const
      const first = await app().request("/push/subscribe", request)
      expect(first.status).toBe(200)
      const firstBody = (await first.json()) as any
      expect(firstBody.id).toBeTruthy()
      expect(firstBody.keys).toBeUndefined()

      const second = await app().request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: APPLE,
          keys: { p256dh: "c", auth: "d" },
        }),
      })
      const secondBody = (await second.json()) as any
      expect(secondBody.id).toBe(firstBody.id)
      expect(await PushStore.list()).toHaveLength(1)
    })
  })

  test("unsubscribe removes the subscription and is idempotent", async () => {
    await withIsolatedHome(async () => {
      await app().request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: APPLE, keys: { p256dh: "a", auth: "b" } }),
      })
      const response = await app().request("/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: APPLE }),
      })
      expect(response.status).toBe(200)
      expect(await PushStore.list()).toHaveLength(0)

      const again = await app().request("/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: APPLE }),
      })
      expect(again.status).toBe(200)
    })
  })

  test("test dispatches through PushService to registered subscriptions", async () => {
    await withIsolatedHome(async () => {
      await app().request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: APPLE, keys: { p256dh: "a", auth: "b" } }),
      })

      const calls: any[] = []
      PushService.setSender(((_sub: any, payload: any) => {
        calls.push(JSON.parse(payload))
        return Promise.resolve({ statusCode: 201 } as any)
      }) as any)

      const response = await app().request("/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(response.status).toBe(200)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.category).toBe("test")
      expect(calls[0]!.tag).toBe("push-test")
    })
  })

  test("test with an endpoint targets only that subscription", async () => {
    await withIsolatedHome(async () => {
      await app().request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: APPLE, keys: { p256dh: "a", auth: "b" } }),
      })
      await app().request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: FCM, keys: { p256dh: "c", auth: "d" } }),
      })

      const calls: any[] = []
      PushService.setSender(((_sub: any, payload: any) => {
        calls.push({ sub: _sub, payload: JSON.parse(payload) })
        return Promise.resolve({ statusCode: 201 } as any)
      }) as any)

      const response = await app().request("/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: APPLE }),
      })
      expect(response.status).toBe(200)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.sub.endpoint).toBe(APPLE)
      expect(calls[0]!.payload.category).toBe("test")
    })
  })

  test("test with an unknown endpoint 404s and a rejected delivery 502s", async () => {
    await withIsolatedHome(async () => {
      await app().request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: APPLE, keys: { p256dh: "a", auth: "b" } }),
      })

      const unknown = await app().request("/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/nope" }),
      })
      expect(unknown.status).toBe(404)

      PushService.setSender((() => {
        const error = new Error("endpoint rejected") as any
        error.statusCode = 500
        return Promise.reject(error)
      }) as any)

      const failed = await app().request("/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: APPLE }),
      })
      expect(failed.status).toBe(502)
    })
  })

  test("categories update applies to one subscription; unknown id 404s", async () => {
    await withIsolatedHome(async () => {
      const subscribe = await app().request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: APPLE, keys: { p256dh: "a", auth: "b" } }),
      })
      const stored = (await subscribe.json()) as any

      const update = await app().request(`/push/subscriptions/${stored.id}/categories`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completion: false, error: true, input: true }),
      })
      expect(update.status).toBe(200)
      const list = (await (await app().request("/push/subscriptions")).json()) as any[]
      expect(list[0]!.categories).toEqual({ completion: false, error: true, input: true })

      const missing = await app().request("/push/subscriptions/push_missing/categories", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completion: false, error: true, input: true }),
      })
      expect(missing.status).toBe(404)
    })
  })
})
