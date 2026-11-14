import { expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPartCommit } from "../../src/session/part-commit"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { StorageEventSinks } from "../../src/storage/event-sinks"
import { testRuntime } from "../support/runtime"

function user(sessionID: string, created: number, id = Identifier.ascending("message")): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    agent: "order-fixture",
    model: { providerID: "fixture", modelID: "native-order" },
    time: { created },
  }
}
function owner(session: Session.Info) {
  return { scopeID: Identifier.asScopeID(session.scope.id), sessionID: Identifier.asSessionID(session.id) }
}
function inScope<T>(session: Session.Info, fn: () => T) {
  return ScopeContext.provide({ scope: session.scope, workspace: null, fn })
}
async function newest(session: Session.Info) {
  return Array.fromAsync(MessageV2.readNewestInfos(owner(session)))
}

// Counts are the original work contract; elapsed time is intentionally not an oracle.
test("one native write transaction scans message order once while retaining every Message and Part commit fact", async () => {
  await using runtime = await testRuntime({
    register: () =>
      StorageEventSinks.register({
        id: "native-order-work",
        capture(event) {
          if (event.type !== MessageV2.Event.Updated.type && event.type !== SessionPartCommit.RecordCommitted.type)
            return
          return { partition: "original-native-session", payload: { type: event.type } }
        },
        async deliver() {},
      }),
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const root = StoragePath.sessionMessageOrderMarkersRoot(owner(session).scopeID, owner(session).sessionID)
        const messages: MessageV2.User[] = []
        using scans = spyOn(Storage, "scan")
        for (let offset = 0; offset < 32; offset += 16)
          await Storage.transaction(async () => {
            for (let index = offset; index < offset + 16; index++) {
              const message = user(session.id, index + 1)
              messages.push(message)
              await Session.updateMessage(message)
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: message.id,
                type: "text",
                text: `Original native Part ${index}`,
              })
            }
          })
        const markerScans = scans.mock.calls.filter(([key]) => JSON.stringify(key) === JSON.stringify(root))
        expect(markerScans).toHaveLength(2)
        const facts = await Storage.query<StorageEventSinks.Delivery>({ kind: "event_delivery", limit: 128 })
        expect(facts).toHaveLength(64)
        expect(
          facts.filter((row) => (row.value.payload as { type: string }).type === MessageV2.Event.Updated.type),
        ).toHaveLength(32)
        expect(
          facts.filter(
            (row) => (row.value.payload as { type: string }).type === SessionPartCommit.RecordCommitted.type,
          ),
        ).toHaveLength(32)
        const history = await Array.fromAsync(MessageV2.stream({ sessionID: session.id }))
        expect(history.map((message) => message.info.id)).toEqual(messages.map((message) => message.id).toReversed())
        expect(history.every((message) => message.parts.length === 1)).toBe(true)
      },
    }),
  )
})

test("same-count raw marker changes and public remove/reorder invalidate only their actual transaction owner", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const first = await Session.create({ workspace: null, environmentID: null })
        const scope = await Scope.registerProject({
          type: "project",
          id: "native-order-other-scope",
          local: null,
          time: { created: 1, updated: 1 },
        })
        const second = await ScopeContext.provide({
          scope,
          workspace: null,
          fn: () => Session.create({ workspace: null, environmentID: null }),
        })
        const a = user(first.id, 10)
        const b = user(first.id, 20)
        const other = user(second.id, 5)
        await inScope(first, async () => {
          await Session.updateMessage(a)
          await Session.updateMessage(b)
        })
        await inScope(second, () => Session.updateMessage(other))
        const firstOwner = owner(first)
        const firstRoot = StoragePath.sessionMessageOrderMarkersRoot(firstOwner.scopeID, firstOwner.sessionID)
        const secondOwner = owner(second)
        const secondRoot = StoragePath.sessionMessageOrderMarkersRoot(secondOwner.scopeID, secondOwner.sessionID)
        using scans = spyOn(Storage, "scan")
        await Storage.transaction(async (tx) => {
          await inScope(first, () => Session.updateMessage(a))
          await inScope(second, () => Session.updateMessage(other))
          const moved = { ...a, time: { created: 30 } }
          await tx.remove(
            StoragePath.sessionMessageOrderMarker(
              firstOwner.scopeID,
              firstOwner.sessionID,
              MessageV2.messageOrderMarker(a),
            ),
          )
          await tx.write(
            StoragePath.messageInfo(firstOwner.scopeID, firstOwner.sessionID, Identifier.asMessageID(a.id)),
            moved,
          )
          await tx.write(
            StoragePath.sessionMessageOrderMarker(
              firstOwner.scopeID,
              firstOwner.sessionID,
              MessageV2.messageOrderMarker(moved),
            ),
            {},
          )
          expect(
            await Storage.read(StoragePath.sessionMessageOrderState(firstOwner.scopeID, firstOwner.sessionID)),
          ).toMatchObject({ ready: true, count: 2 })
          const next = user(first.id, 25)
          await inScope(first, () => Session.updateMessage(next))
          await inScope(second, () => Session.updateMessage(other))
          expect((await newest(first)).map((message) => message.id)).toEqual([a.id, next.id, b.id])
          await inScope(first, () => Session.removeMessage({ sessionID: first.id, messageID: b.id }))
          await inScope(first, () => Session.updateMessage({ ...next, time: { created: 40 } }))
          await MessageV2.removeOrderIndex(firstOwner.scopeID, firstOwner.sessionID)
          const final = user(first.id, 35)
          await inScope(first, () => Session.updateMessage(final))
          expect((await newest(first)).map((message) => message.id)).toEqual([next.id, final.id, a.id])
          expect((await newest(second)).map((message) => message.id)).toEqual([other.id])
        })
        expect(scans.mock.calls.filter(([key]) => JSON.stringify(key) === JSON.stringify(firstRoot))).toHaveLength(3)
        expect(scans.mock.calls.filter(([key]) => JSON.stringify(key) === JSON.stringify(secondRoot))).toHaveLength(1)
      },
    }),
  )
})

test("rolled-back message order never crosses original Runtime or Store and the next transaction reads its own snapshot", async () => {
  await using first = await testRuntime()
  await using second = await testRuntime()
  const sessionID = Identifier.descending("session")
  const sharedID = Identifier.ascending("message")
  async function seed(runtime: typeof first, created: number) {
    return runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const session = await Session.create({ id: sessionID, workspace: null, environmentID: null })
          const message = user(session.id, created, sharedID)
          await Session.updateMessage(message)
          return { session, message }
        },
      }),
    )
  }
  const a = await seed(first, 10)
  const b = await seed(second, 20)
  const rejected = new Error("Original native transaction rolled back")
  await first.run(() =>
    inScope(a.session, async () => {
      await expect(
        Storage.transaction(async () => {
          await Session.updateMessage({ ...a.message, time: { created: 100 } })
          await Session.updateMessage(user(a.session.id, 200))
          await Session.removeMessage({ sessionID: a.session.id, messageID: sharedID })
          expect(() => second.run(() => Storage.current())).toThrow(
            "Cannot switch runtimes inside a storage transaction",
          )
          throw rejected
        }),
      ).rejects.toBe(rejected)
      expect((await newest(a.session)).map((message) => [message.id, message.time.created])).toEqual([[sharedID, 10]])
      const root = StoragePath.sessionMessageOrderMarkersRoot(owner(a.session).scopeID, owner(a.session).sessionID)
      using scans = spyOn(Storage, "scan")
      await Storage.transaction(() => Session.updateMessage(a.message))
      expect(scans.mock.calls.filter(([key]) => JSON.stringify(key) === JSON.stringify(root))).toHaveLength(1)
      expect((await Storage.snapshot(() => newest(a.session))).map((message) => message.time.created)).toEqual([10])
    }),
  )
  await second.run(() =>
    inScope(b.session, async () => {
      expect((await newest(b.session)).map((message) => [message.id, message.time.created])).toEqual([[sharedID, 20]])
    }),
  )
})

test("native message order caches keep legal Scope and Session delimiter tuples distinct", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const firstID = "ses_000000000001aaaaaaaaaaaaaa"
    const lastID = "ses_000000000002bbbbbbbbbbbbbb"
    const scopeID = "native-order-delimiter"
    const scopes = await Promise.all(
      [`${scopeID}:${firstID}`, scopeID].map((id) =>
        Scope.registerProject({ type: "project", id, local: null, time: { created: 1, updated: 1 } }),
      ),
    )
    const sessions: Session.Info[] = []
    for (const [index, scope] of scopes.entries())
      sessions.push(
        await ScopeContext.provide({
          scope,
          workspace: null,
          fn: () =>
            Session.create({ id: index === 0 ? lastID : `${firstID}:${lastID}`, workspace: null, environmentID: null }),
        }),
      )
    const messages = sessions.map((session, index) => user(session.id, index + 1))
    for (const [index, session] of sessions.entries())
      await inScope(session, () => Session.updateMessage(messages[index]!))
    await Storage.transaction(async () => {
      for (const [index, session] of sessions.entries()) {
        await inScope(session, () => Session.updateMessage({ ...messages[index]!, time: { created: index + 10 } }))
        const actual = owner(session)
        expect(
          await Storage.read(StoragePath.sessionMessageOrderState(actual.scopeID, actual.sessionID)),
        ).toMatchObject({ ready: true, count: 1 })
      }
      for (const [index, session] of sessions.entries())
        expect((await newest(session)).map((message) => [message.id, message.time.created])).toEqual([
          [messages[index]!.id, index + 10],
        ])
    })
  })
})
