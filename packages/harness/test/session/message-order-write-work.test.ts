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
import { StorageMutationGuard } from "../../src/storage/mutation-guard"
import type { SqlQueryOptions, SqlRow, SqlValue } from "../../src/storage/sql-contract"
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

function countMarkerCollectionWork(markers: ReadonlySet<string>, active: () => boolean) {
  const arraySlice = Array.prototype.slice
  const arrayFilter = Array.prototype.filter
  const stringSlice = String.prototype.slice
  let elements = 0
  const selected = (value: unknown) =>
    Array.isArray(value) && value.length > 0 && typeof value[0] === "string" && markers.has(value[0])
  const slices = spyOn(Array.prototype, "slice").mockImplementation(function (
    this: unknown[],
    ...args: Parameters<typeof arraySlice>
  ) {
    const result = arraySlice.apply(this, args)
    if (active() && selected(this)) elements += result.length
    return result
  })
  const filters = spyOn(Array.prototype, "filter").mockImplementation(function (
    this: unknown[],
    ...args: Parameters<typeof arrayFilter>
  ) {
    if (active() && selected(this)) elements += this.length
    return arrayFilter.apply(this, args)
  })
  const strings = spyOn(String.prototype, "slice").mockImplementation(function (
    this: string,
    ...args: Parameters<typeof stringSlice>
  ) {
    if (
      active() &&
      typeof this === "string" &&
      markers.has(this) &&
      ((args[0] === 0 && args[1] === 16) || args[0] === 17)
    )
      elements++
    return stringSlice.apply(this, args)
  })
  return {
    count: () => elements,
    [Symbol.dispose]() {
      strings.mockRestore()
      filters.mockRestore()
      slices.mockRestore()
    },
  }
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
        const markers = new Set<string>()
        let orderWrites = 0
        using work = countMarkerCollectionWork(markers, () => orderWrites > 0)
        const writeInfo = MessageV2.writeInfo
        using writes = spyOn(MessageV2, "writeInfo").mockImplementation(async (input) => {
          orderWrites++
          try {
            return await writeInfo(input)
          } finally {
            orderWrites--
          }
        })
        using scans = spyOn(Storage, "scan")
        for (let offset = 0; offset < 32; offset += 16)
          await Storage.transaction(async () => {
            for (let index = offset; index < offset + 16; index++) {
              const message = user(session.id, index + 1)
              messages.push(message)
              markers.add(MessageV2.messageOrderMarker(message))
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
        const writerMarkerWork = work.count()
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
        expect(writerMarkerWork).toBeLessThanOrEqual(8 * messages.length)
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
      const cancellation = new AbortController()
      const cancelled = new Error("Original native order callback was cancelled")
      await expect(
        Storage.transaction(async () => {
          await Session.updateMessage({ ...a.message, time: { created: 300 } })
          await Session.updateMessage(user(a.session.id, 400))
          cancellation.abort(cancelled)
          cancellation.signal.throwIfAborted()
        }),
      ).rejects.toBe(cancelled)
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

test("incremental native message ordering preserves tied timestamps, earlier inserts and original removal", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const messages = [
          user(session.id, 8, Identifier.asMessageID("msg_order_late")),
          user(session.id, 2, Identifier.asMessageID("msg_order_tie_z")),
          user(session.id, -2.5, Identifier.asMessageID("msg_order_earliest")),
          user(session.id, 2, Identifier.asMessageID("msg_order_tie_a")),
          user(session.id, 0, Identifier.asMessageID("msg_order_middle")),
        ]
        await Storage.transaction(async () => {
          for (const message of messages) await Session.updateMessage(message)
          expect((await newest(session)).map((message) => message.id)).toEqual(
            messages
              .toSorted(MessageV2.compareStorageOrder)
              .toReversed()
              .map((message) => message.id),
          )
          const moved = { ...messages[0]!, time: { created: -4.25 } }
          await Session.updateMessage(moved)
          await Session.removeMessage({ sessionID: session.id, messageID: messages[1]!.id })
          const expected = [moved, ...messages.slice(2)].toSorted(MessageV2.compareStorageOrder).toReversed()
          expect((await newest(session)).map((message) => [message.id, message.time.created])).toEqual(
            expected.map((message) => [message.id, message.time.created]),
          )
          expect(
            await Storage.read(StoragePath.sessionMessageOrderState(owner(session).scopeID, owner(session).sessionID)),
          ).toMatchObject({ ready: true, count: expected.length })
        })
        expect((await newest(session)).map((message) => message.id)).toEqual([
          messages[3]!.id,
          messages[4]!.id,
          messages[2]!.id,
          messages[0]!.id,
        ])
      },
    }),
  )
})

for (const count of [129, 5_000])
  test(`cold message order rebuild batches original marker SQL for ${count} legacy headers`, async () => {
    let selected: { state: string[]; markerKeys: Set<string> } | undefined
    let guarded: string[] = []
    let stagingValid = true
    await using runtime = await testRuntime({
      register() {
        StorageMutationGuard.register("cold-order-staging", async (tx, keys) => {
          if (!selected) return
          const markers = keys.filter((key) => selected!.markerKeys.has(JSON.stringify(key)))
          if (!markers.length) return
          guarded.push(...markers.map((key) => JSON.stringify(key)))
          const [current] = await tx.readMany<{ ready: boolean }>([selected.state])
          stagingValid &&= current?.ready === false
        })
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const session = await Session.create({ workspace: null, environmentID: null })
          const original = owner(session)
          const messages = Array.from({ length: count }, (_, index) => user(session.id, count - index))
          const infoKeys = messages.map((message) =>
            StoragePath.messageInfo(original.scopeID, original.sessionID, Identifier.asMessageID(message.id)),
          )
          await Storage.transaction(async (tx) => {
            for (let offset = 0; offset < messages.length; offset += 128)
              await tx.writeMany(
                messages.slice(offset, offset + 128).map((value, index) => ({ key: infoKeys[offset + index], value })),
              )
          })
          const revisions = await Storage.revisions(infoKeys)
          const markers = messages.map((message) =>
            StoragePath.sessionMessageOrderMarker(
              original.scopeID,
              original.sessionID,
              MessageV2.messageOrderMarker(message),
            ),
          )
          const state = StoragePath.sessionMessageOrderState(original.scopeID, original.sessionID)
          const stale = StoragePath.sessionMessageOrderMarker(
            original.scopeID,
            original.sessionID,
            "old-incomplete-marker",
          )
          await Storage.write(stale, {})
          await Storage.write(state, { version: 1, ready: false, count: 1 })
          selected = { state, markerKeys: new Set(markers.map((key) => JSON.stringify(key))) }
          let markerSQL = 0
          let observed: MessageV2.Info[] = []
          await Storage.transaction(async (tx) => {
            const raw = tx.raw
            const query = raw.query
            raw.query = <Row extends SqlRow>(statement: string, values?: SqlValue[], options?: SqlQueryOptions) => {
              if (
                statement.startsWith("INSERT INTO storage_records") &&
                values?.some((value) => typeof value === "string" && selected!.markerKeys.has(value))
              )
                markerSQL++
              return query<Row>(statement, values, options)
            }
            try {
              observed = await newest(session)
            } finally {
              raw.query = query
            }
          })
          selected = undefined
          expect(markerSQL).toBeGreaterThan(0)
          expect(markerSQL).toBeLessThanOrEqual(Math.ceil(count / 64))
          expect(guarded.length).toBe(count)
          expect(new Set(guarded)).toEqual(new Set(markers.map((key) => JSON.stringify(key))))
          expect(stagingValid).toBe(true)
          expect(observed.map((message) => message.id)).toEqual(messages.map((message) => message.id))
          expect(
            await Storage.scan(StoragePath.sessionMessageOrderMarkersRoot(original.scopeID, original.sessionID)),
          ).toEqual(markers.map((key) => key.at(-1)!).sort())
          expect(await Storage.readMany([state])).toEqual([{ version: 1, ready: true, count }])
          expect(await Storage.revisions(infoKeys)).toEqual(revisions)
          expect(await Storage.readMany(infoKeys)).toEqual(messages)
        },
      }),
    )
  }, 60_000)

test("a rejected cold marker page rolls back its original index and duplicate legacy markers do not acquire a new rejection", async () => {
  const rejected = new Error("Original cold marker publication rejected")
  let failingKey: string | undefined
  await using runtime = await testRuntime({
    register() {
      StorageMutationGuard.register("cold-order-failure", async (_tx, keys) => {
        if (failingKey && keys.some((key) => JSON.stringify(key) === failingKey)) throw rejected
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const original = owner(session)
        const messages = Array.from({ length: 129 }, (_, index) => user(session.id, index + 1))
        const infoKeys = messages.map((message) =>
          StoragePath.messageInfo(original.scopeID, original.sessionID, Identifier.asMessageID(message.id)),
        )
        await Storage.transaction((tx) =>
          tx.writeMany(messages.map((value, index) => ({ key: infoKeys[index], value }))),
        )
        const state = StoragePath.sessionMessageOrderState(original.scopeID, original.sessionID)
        const root = StoragePath.sessionMessageOrderMarkersRoot(original.scopeID, original.sessionID)
        const stale = StoragePath.sessionMessageOrderMarker(
          original.scopeID,
          original.sessionID,
          "old-incomplete-marker",
        )
        await Storage.write(stale, {})
        await Storage.write(state, { version: 1, ready: false, count: 1 })
        const revisions = await Storage.revisions(infoKeys)
        failingKey = JSON.stringify(
          StoragePath.sessionMessageOrderMarker(
            original.scopeID,
            original.sessionID,
            MessageV2.messageOrderMarker(messages[100]),
          ),
        )
        const outcome = await newest(session).then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        )
        expect(outcome.kind).toBe("rejected")
        if (outcome.kind === "rejected") expect(outcome.error).toBe(rejected)
        failingKey = undefined
        expect(await Storage.scan(root)).toEqual(["old-incomplete-marker"])
        expect(await Storage.readMany([state])).toEqual([{ version: 1, ready: false, count: 1 }])
        expect(await Storage.revisions(infoKeys)).toEqual(revisions)
        expect((await newest(session)).map((message) => message.id)).toEqual(
          messages.toReversed().map((message) => message.id),
        )
        const legacy = await Session.create({ workspace: null, environmentID: null })
        const legacyOwner = owner(legacy)
        const repeated = user(legacy.id, 1)
        const alias = Identifier.ascending("message")
        await Storage.transaction((tx) =>
          tx.writeMany([
            {
              key: StoragePath.messageInfo(
                legacyOwner.scopeID,
                legacyOwner.sessionID,
                Identifier.asMessageID(repeated.id),
              ),
              value: repeated,
            },
            { key: StoragePath.messageInfo(legacyOwner.scopeID, legacyOwner.sessionID, alias), value: repeated },
          ]),
        )
        expect((await newest(legacy)).map((message) => message.id)).toEqual([repeated.id, repeated.id])
        expect(
          await Storage.readMany([StoragePath.sessionMessageOrderState(legacyOwner.scopeID, legacyOwner.sessionID)]),
        ).toEqual([{ version: 1, ready: true, count: 2 }])
      },
    }),
  )
})
