import path from "node:path"
import fs from "node:fs/promises"
import { afterEach, describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { PermissionNext } from "../../src/permission/next"
import { PushBridge } from "../../src/push/bridge"
import { PushService } from "../../src/push/service"
import { PushStore } from "../../src/push/store"
import { Question } from "../../src/question"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionEvent } from "../../src/session/event"
import { Identifier } from "../../src/id/id"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { tmpdir } from "../fixture/fixture"

type SentCall = { payload: any; options: any }

const APPLE = "https://web.push.apple.com/push/v1/device-a"

function recordingSender() {
  const calls: SentCall[] = []
  const send = ((_subscription: any, payload: any, options: any) => {
    calls.push({ payload: JSON.parse(payload), options })
    return Promise.resolve({ statusCode: 201 } as any)
  }) as any
  return { calls, send }
}

let disposeBridge: (() => void) | undefined

afterEach(() => {
  disposeBridge?.()
  disposeBridge = undefined
  PushService.resetSender()
})

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

async function setupSubscriber() {
  await PushStore.upsert({ endpoint: APPLE, keys: { p256dh: "a", auth: "b" } })
}

describe("PushBridge", () => {
  test("no subscriptions: bridge has zero side effects on events", async () => {
    await withIsolatedHome(async () => {
      disposeBridge = PushBridge.init()
      const { calls, send } = recordingSender()
      PushService.setSender(send)

      await Bus.publish(SessionEvent.Completion, {
        sessionID: Identifier.ascending("session"),
        unreadCount: 1,
      }).catch(() => undefined)
      await PushBridge.flush()
      expect(calls).toHaveLength(0)
    })
  })

  test("completion pushes for root sessions with href contract and badge", async () => {
    await withIsolatedHome(async () => {
      await setupSubscriber()
      disposeBridge = PushBridge.init()
      const { calls, send } = recordingSender()
      PushService.setSender(send)

      const session = await Session.create({ title: "Push bridge test" })
      await Bus.publish(SessionEvent.Completion, { sessionID: session.id, unreadCount: 2 })
      await PushBridge.flush()

      expect(calls).toHaveLength(1)
      const payload = calls[0]!.payload
      expect(payload.title).toBe("Response ready")
      expect(payload.body).toBe("Push bridge test")
      expect(payload.category).toBe("completion")
      expect(payload.tag).toBe(`session-${session.id}`)
      expect(payload.badge).toBe(2)
      expect(payload.href).toBe(`/${base64Encode("home")}/session/${session.id}`)
    })
  })

  test("completion skips child sessions; error skips children; input does not", async () => {
    await withIsolatedHome(async () => {
      await setupSubscriber()
      disposeBridge = PushBridge.init()
      const { calls, send } = recordingSender()
      PushService.setSender(send)

      const parent = await Session.create({ title: "Parent" })
      const child = await Session.create({ title: "Child", parentID: parent.id })

      await Bus.publish(SessionEvent.Completion, { sessionID: child.id, unreadCount: 1 })
      await PushBridge.flush()
      expect(calls).toHaveLength(0)

      await Bus.publish(SessionEvent.Error, { sessionID: child.id, error: "boom" })
      await PushBridge.flush()
      expect(calls).toHaveLength(0)

      await Bus.publish(Question.Event.Asked, {
        id: Identifier.ascending("question"),
        sessionID: child.id,
        questions: [],
        timeout: 600,
        createdAt: Date.now(),
      } as any)
      await PushBridge.flush()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.payload.category).toBe("input")
      expect(calls[0]!.payload.title).toBe("Session needs your input")
      expect(calls[0]!.payload.tag).toBe(`input-${child.id}`)
    })
  })

  test("channel-endpoint sessions are skipped for all categories", async () => {
    await withIsolatedHome(async () => {
      await setupSubscriber()
      disposeBridge = PushBridge.init()
      const { calls, send } = recordingSender()
      PushService.setSender(send)

      const session = await Session.create({
        title: "Feishu session",
        endpoint: SessionEndpoint.fromChannel({
          type: "feishu",
          chatId: "oc_test",
          scopeKey: "feishu:oc_test",
          createdAt: Date.now(),
        }),
      })

      await Bus.publish(SessionEvent.Completion, { sessionID: session.id, unreadCount: 1 })
      await Bus.publish(SessionEvent.Error, { sessionID: session.id, error: "boom" })
      await Bus.publish(Question.Event.Asked, {
        id: Identifier.ascending("question"),
        sessionID: session.id,
        questions: [],
        timeout: 600,
        createdAt: Date.now(),
      } as any)
      await PushBridge.flush()
      expect(calls).toHaveLength(0)
    })
  })

  test("permission asked pushes input category; unknown sessions are silent", async () => {
    await withIsolatedHome(async () => {
      await setupSubscriber()
      disposeBridge = PushBridge.init()
      const { calls, send } = recordingSender()
      PushService.setSender(send)

      const session = await Session.create({ title: "Permission target" })
      await Bus.publish(PermissionNext.Event.Asked, {
        id: Identifier.ascending("permission"),
        sessionID: session.id,
        permission: "bash",
        patterns: ["*"],
        metadata: {},
      } as any)
      await PushBridge.flush()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.payload.category).toBe("input")

      await Bus.publish(SessionEvent.Completion, {
        sessionID: Identifier.ascending("session"),
        unreadCount: 1,
      })
      await PushBridge.flush()
      expect(calls).toHaveLength(1)
    })
  })

  test("error without session resolves to scope root href", async () => {
    await withIsolatedHome(async () => {
      await setupSubscriber()
      disposeBridge = PushBridge.init()
      const { calls, send } = recordingSender()
      PushService.setSender(send)

      await Bus.publish(SessionEvent.Error, { error: "global failure" })
      await PushBridge.flush()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.payload.href).toBe(`/${base64Encode("home")}`)
      expect(calls[0]!.payload.body).toBe("global failure")
    })
  })

  test("unresolved session-scoped errors stay silent (no global fallback)", async () => {
    await withIsolatedHome(async () => {
      await setupSubscriber()
      disposeBridge = PushBridge.init()
      const { calls, send } = recordingSender()
      PushService.setSender(send)

      // A sessionID that no longer resolves must not emit a misleading
      // global push containing the raw error text.
      await Bus.publish(SessionEvent.Error, {
        sessionID: Identifier.ascending("session"),
        error: "boom for a deleted session",
      })
      await PushBridge.flush()
      expect(calls).toHaveLength(0)
    })
  })

  test("long titles are truncated to the body limit", async () => {
    await withIsolatedHome(async () => {
      await setupSubscriber()
      disposeBridge = PushBridge.init()
      const { calls, send } = recordingSender()
      PushService.setSender(send)

      const session = await Session.create({ title: "x".repeat(300) })
      await Bus.publish(SessionEvent.Completion, { sessionID: session.id, unreadCount: 1 })
      await PushBridge.flush()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.payload.body.length).toBeLessThanOrEqual(200)
    })
  })
})
