import { expect, test } from "bun:test"
import { z } from "zod"
import { PrimaryAgentIdentity } from "../../src/agent/primary-identity"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { StorageEventSinks } from "../../src/storage/event-sinks"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

const Fact = z.object({
  properties: z.object({ scopeID: z.string(), sessionID: z.string(), itemID: z.string(), revision: z.string() }),
})
async function root() {
  const session = await Session.create({ workspace: null })
  const id = Identifier.ascending("message")
  await Session.updateMessage({
    id,
    sessionID: session.id,
    role: "user",
    agent: PrimaryAgentIdentity.names.general,
    model: { providerID: "test", modelID: "test" },
    time: { created: 1 },
    isRoot: true,
    rootID: id,
  })
  return { session, id }
}
const mail = (sessionID: string) => ({
  sessionID,
  deliveryKey: "cortex:taskNotification:original-task",
  mode: "context" as const,
  message: {
    role: "user" as const,
    model: { providerID: "test", modelID: "test" },
    parts: [
      {
        type: "text" as const,
        text: "Original public notification preview ".repeat(6) + "PRIVATE_BODY_NOT_IN_SELECTOR",
      },
    ],
  },
})

test("native Inbox commit retains original notification metadata through consumption and a cold receiver", async () => {
  await using directory = await tmpdir()
  let original: unknown
  let retained: unknown
  let target: { sessionID: string; itemID: string; messageID: string }
  const received: unknown[] = []
  const sink = {
    id: "native-inbox-facts",
    async capture(event: Parameters<StorageEventSinks.Sink["capture"]>[0]) {
      if (event.type !== "session.inbox.item.committed") return
      const value = Fact.parse(event.payload).properties
      const item = await SessionInbox.getStored(value.sessionID, value.itemID)
      expect(Storage.inWriteTransaction()).toBe(true)
      expect(item.sessionID).toBe(value.sessionID)
      expect(item.id).toBe(value.itemID)
      if (item.deliveryKey !== "cortex:taskNotification:original-task") return
      return {
        partition: value.sessionID,
        payload: {
          scopeID: value.scopeID,
          sessionID: item.sessionID,
          itemID: item.id,
          messageID: item.messageID,
          deliveryKey: item.deliveryKey,
          createdAt: item.time.created,
          summary: item.summary.preview ?? item.summary.title,
        },
      }
    },
    async deliver(value: Readonly<StorageEventSinks.Delivery>) {
      received.push(value.payload)
    },
  }
  {
    await using runtime = await testRuntime({ home: directory.path, register: () => StorageEventSinks.register(sink) })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const f = await root()
          const accepted = await SessionInbox.deliverUnique(mail(f.session.id))
          target = { sessionID: f.session.id, itemID: accepted.itemID, messageID: accepted.messageID }
          const item = await SessionInbox.getStored(target.sessionID, target.itemID)
          original = {
            scopeID: f.session.scope.id,
            sessionID: item.sessionID,
            itemID: item.id,
            messageID: item.messageID,
            deliveryKey: item.deliveryKey,
            createdAt: item.time.created,
            summary: item.summary.preview ?? item.summary.title,
          }
          const rows = await Storage.query<StorageEventSinks.Delivery>({ kind: "event_delivery" })
          expect(rows).toHaveLength(1)
          expect(rows[0]!.value.payload).toEqual(original)
          expect(JSON.stringify(rows[0]!.value)).not.toContain("PRIVATE_BODY_NOT_IN_SELECTOR")
          retained = rows[0]!.value
          const materialized = await SessionInbox.materializeItem(item, f.id)
          expect(materialized?.info.id).toBe(item.messageID)
          await SessionInbox.commitReady(f.session.id, [item.id])
          expect(await SessionInbox.list(f.session.id)).toEqual([])
          expect(
            (await MessageV2.get({ sessionID: f.session.id, messageID: item.messageID })).parts.some(
              (part) => part.type === "text" && part.text.includes("PRIVATE_BODY_NOT_IN_SELECTOR"),
            ),
          ).toBe(true)
        },
      }),
    )
  }
  await using runtime = await testRuntime({ home: directory.path, register: () => StorageEventSinks.register(sink) })
  await runtime.run(async () => {
    expect(await SessionInbox.list(target!.sessionID)).toEqual([])
    expect((await Storage.query({ kind: "event_delivery" })).map((row) => row.value)).toEqual([retained])
    expect(await StorageEventSinks.flush()).toEqual({ delivered: 1 })
    expect(received).toEqual([original])
    expect(await Storage.query({ kind: "event_delivery" })).toEqual([])
  })
})

test("native Inbox capture failure rolls back the item and its original receipt before a successful retry", async () => {
  const fault = new Error("Original Inbox capture unavailable")
  let fail = true
  await using runtime = await testRuntime({
    register() {
      StorageEventSinks.register({
        id: "native-inbox-facts",
        capture(event) {
          if (event.type !== "session.inbox.item.committed") return
          if (fail) throw fault
          const value = Fact.parse(event.payload).properties
          return { partition: value.sessionID, payload: value }
        },
        async deliver() {},
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const f = await root()
        const input = mail(f.session.id)
        const pending = await Storage.current().store.pendingEvents()
        await expect(SessionInbox.deliverUnique(input)).rejects.toBe(fault)
        expect(await SessionInbox.list(f.session.id)).toEqual([])
        expect(await Storage.query({ kind: "event_delivery" })).toEqual([])
        expect(await Storage.current().store.pendingEvents()).toEqual(pending)
        fail = false
        const accepted = await SessionInbox.deliverUnique(input)
        expect(accepted.created).toBe(true)
        expect(await SessionInbox.list(f.session.id)).toHaveLength(1)
        expect(await Storage.query({ kind: "event_delivery" })).toHaveLength(1)
        expect(await SessionInbox.deliverUnique(input)).toEqual({ ...accepted, created: false })
        expect(await Storage.query({ kind: "event_delivery" })).toHaveLength(1)
      },
    }),
  )
})
