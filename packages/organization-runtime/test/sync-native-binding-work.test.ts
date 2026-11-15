import { expect, spyOn, test } from "bun:test"
import { z } from "zod"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionTransferCore as Core } from "@ericsanchezok/synergy-harness/session/transfer"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import type { SqlQueryOptions, SqlRow, SqlValue } from "../../harness/src/storage/sql-contract"
import { registerSessionSchema } from "../src/session-schema"
import { binding, mutationBinding, Draft } from "../src/sync-outbox"
import { pumpNativeSync } from "../src/sync-native-source"
import { OrganizationSyncPath as Keys } from "../src/storage/path"

const original = {
  schemaVersion: 1,
  orgID: "native-read-work-org",
  projectID: "native-read-work-project",
  creatorID: "native-read-work-creator",
  driverRuntimeID: "native-read-work-runtime",
  bindingEpoch: 1,
} as const

async function rejected<T>(pending: Promise<T>) {
  const outcome = await pending.then(
    () => ({ kind: "resolved" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  )
  expect(outcome.kind).toBe("rejected")
  if (outcome.kind === "resolved") throw new Error("The original native operation unexpectedly resolved")
  return outcome.error
}

test("one durable native delivery window bounds prewrite Session metadata reads while retaining every projected fact", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(original) })
  await runtime.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: original.projectID,
      local: null,
      time: { created: 1, updated: 1 },
    })
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const session = await Session.create({ organization: original, workspace: null, environmentID: null })
        const counts = {
          probe: { reads: 0, keys: 0, prewrite: 0 },
          native: { reads: 0, keys: 0, prewrite: 0 },
          delivery: { reads: 0, keys: 0, prewrite: 0 },
        }
        let phase: keyof typeof counts | undefined = "probe"
        const markerRoot = StoragePath.sessionMessageOrderMarkersRoot(
          Identifier.asScopeID(scope.id),
          Identifier.asSessionID(session.id),
        )
        let markerScans = 0
        const scan = Storage.scan
        using scans = spyOn(Storage, "scan").mockImplementation((prefix: string[]) => {
          if (
            phase === "native" &&
            prefix.length === markerRoot.length &&
            prefix.every((part, i) => part === markerRoot[i])
          )
            markerScans++
          return scan(prefix)
        })
        const readMany = Storage.readMany
        using reads = spyOn(Storage, "readMany").mockImplementation(<T>(keys: string[][]) => {
          const native = keys.filter(
            (key) =>
              (key[0] === "session_index" && key[1] === session.id) ||
              (key[0] === "sessions" &&
                key[1] === scope.id &&
                key[2] === session.id &&
                key[3] === "info" &&
                key.length === 4),
          )
          if (phase !== undefined && native.length) {
            const counter = counts[phase]
            counter.reads++
            counter.keys += native.length
            if (Storage.inWriteTransaction()) counter.prewrite++
          }
          return readMany<T>(keys)
        })
        const probes: Array<string | undefined> = []
        for (let index = 0; index < 32; index++)
          probes.push((await mutationBinding(session.id, original.orgID, scope.id))?.rootSessionID)
        phase = "native"
        let nativeTransactions = 0
        const seenTransactions = new WeakSet<object>()
        const windows: Array<{ messages: number; markerScans: number; metadataReads: number; elapsedMs: number }> = []
        const messages: string[] = []
        const parts: string[] = []
        for (let offset = 0; offset < 32; offset += 16) {
          const started = performance.now()
          const beforeScans = markerScans
          const beforeReads = counts.native.reads
          await Storage.transaction(async (tx) => {
            if (!seenTransactions.has(tx)) {
              seenTransactions.add(tx)
              nativeTransactions++
            }
            for (let index = offset; index < offset + 16; index++) {
              const messageID = Identifier.ascending("message")
              const partID = Identifier.ascending("part")
              messages.push(messageID)
              parts.push(partID)
              await Session.updateMessage({
                id: messageID,
                sessionID: session.id,
                role: "user",
                agent: "binding-work-fixture",
                model: { providerID: "fixture", modelID: "bounded-native-binding" },
                time: { created: index + 1 },
              })
              await Session.updatePart({
                id: partID,
                sessionID: session.id,
                messageID,
                type: "text",
                text: `Original native delivery ${index}`,
              })
            }
          })
          windows.push({
            messages: 16,
            markerScans: markerScans - beforeScans,
            metadataReads: counts.native.reads - beforeReads,
            elapsedMs: performance.now() - started,
          })
        }
        phase = undefined
        const owner = await binding(session.id, original.orgID)
        if (!owner) throw new Error("The original native owner is missing")
        const pending = await Storage.query({ kind: "event_delivery", limit: 128 })
        expect(pending.length).toBeGreaterThanOrEqual(64)
        expect(pending.length).toBeLessThanOrEqual(128)
        phase = "delivery"
        await pumpNativeSync(owner)
        phase = undefined
        const actualReads = counts.delivery.reads
        const actualKeys = counts.delivery.keys
        const actualPrewrite = counts.delivery.prewrite
        expect(await Storage.query({ kind: "event_delivery", limit: 128 })).toEqual([])
        const drafts = (await Storage.query({ prefix: Keys.drafts(original.orgID, session.id), limit: 128 })).map(
          (row) => Draft.parse(row.value),
        )
        expect(
          drafts.flatMap((draft) => (draft.event.type === "message" ? [draft.event.messageID] : [])).sort(),
        ).toEqual(messages.toSorted())
        expect(drafts.flatMap((draft) => (draft.event.type === "part" ? [draft.event.partID] : [])).sort()).toEqual(
          parts.toSorted(),
        )
        console.error(
          "NATIVE_BINDING_READ_WORK",
          JSON.stringify({
            deliveries: pending.length,
            drafts: drafts.length,
            metadataReads: actualReads,
            metadataKeys: actualKeys,
            prewriteMetadataReads: actualPrewrite,
          }),
        )
        console.error(
          "NATIVE_BINDING_COMBINED_WORK",
          JSON.stringify({ nativeTransactions, markerScans, windows, counts }),
        )
        expect(actualPrewrite).toBeLessThanOrEqual(32)
        expect(nativeTransactions).toBe(2)
        expect(markerScans).toBe(2)
        expect(windows.map((window) => window.markerScans)).toEqual([1, 1])
        expect(probes).toEqual(Array(32).fill(session.id))
        expect(counts.probe.reads).toBeLessThanOrEqual(32)
        expect(counts.probe.keys).toBe(64)
        const wrongScope = await rejected(mutationBinding(session.id, original.orgID, "another-scope"))
        expect(wrongScope).toMatchObject({ message: expect.stringContaining("Scope") })
      },
    })
  })
})

test("fresh native creation-pair probes preserve absence, owner validation and current Store changes", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(original) })
  await using other = await testRuntime({ register: () => registerSessionSchema(original) })
  await runtime.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: original.projectID,
      local: null,
      time: { created: 1, updated: 1 },
    })
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const session = await Session.create({ organization: original, workspace: null, environmentID: null })
        const sessionID = Identifier.asSessionID(session.id)
        const scopeID = Identifier.asScopeID(scope.id)
        const indexKey = StoragePath.sessionIndex(sessionID)
        const infoKey = StoragePath.sessionInfo(scopeID, sessionID)
        const before = await mutationBinding(session.id, original.orgID, scope.id)
        expect(before?.rootSessionID).toBe(session.id)
        const discarded = new Error("Discard only the controlled native metadata change")
        for (const missing of [indexKey, infoKey]) {
          const error = await rejected(
            Storage.transaction(async () => {
              await Storage.remove(missing)
              expect(await mutationBinding(session.id, original.orgID, scope.id)).toBeUndefined()
              const absent = await rejected(Core.storedInfo({ scopeID: scope.id, sessionID: session.id }))
              expect(absent).toMatchObject({ message: expect.stringContaining("absent") })
              throw discarded
            }),
          )
          expect(error).toBe(discarded)
          expect(await mutationBinding(session.id, original.orgID, scope.id)).toEqual(before)
        }
        const wrongScope = await rejected(
          Storage.transaction(async () => {
            await Storage.update<Record<string, unknown>>(indexKey, (index) => {
              index.scopeID = "another-current-scope"
            })
            await mutationBinding(session.id, original.orgID, scope.id)
          }),
        )
        expect(wrongScope).toMatchObject({ message: expect.stringContaining("Scope") })
        const wrongParent = await rejected(
          Storage.transaction(async () => {
            await Storage.update<Record<string, unknown>>(indexKey, (index) => {
              index.parentID = "another-current-parent"
            })
            await mutationBinding(session.id, original.orgID, scope.id)
          }),
        )
        expect(wrongParent).toMatchObject({ message: expect.stringContaining("canonical owner") })
        const corrupt = await rejected(
          Storage.transaction(async () => {
            await Storage.write(infoKey, { id: session.id })
            await mutationBinding(session.id, original.orgID, scope.id)
          }),
        )
        expect(corrupt).toBeInstanceOf(z.ZodError)
        const unbound = await rejected(
          Storage.transaction(async () => {
            const current = await Storage.read<Record<string, unknown>>(infoKey)
            const { organization: _binding, ...withoutBinding } = current
            await Storage.write(infoKey, withoutBinding)
            expect(await mutationBinding(session.id, original.orgID, scope.id)).toBeUndefined()
            throw discarded
          }),
        )
        expect(unbound).toBe(discarded)
        expect(await mutationBinding(session.id, original.orgID, scope.id)).toEqual(before)
        expect(await other.run(() => mutationBinding(session.id, original.orgID, scope.id))).toBeUndefined()
        expect(await mutationBinding(session.id, original.orgID, scope.id)).toEqual(before)
      },
    })
  })
})

test("canonical stored Session readers keep invalid selection failures in their returned Promise", async () => {
  for (const read of [Core.storedInfo, Core.storedInfoIfComplete, Core.storedInfoIfPresent]) {
    for (const selection of [
      { scopeID: "", sessionID: "invalid-session" },
      { scopeID: "home", sessionID: "" },
    ]) {
      let pending: ReturnType<typeof read> | undefined
      expect(() => {
        pending = read(selection)
      }).not.toThrow()
      expect(pending).toBeInstanceOf(Promise)
      if (!pending) throw new Error("The original stored Session reader did not return its Promise")
      expect(await rejected(pending)).toBeInstanceOf(z.ZodError)
    }
  }
})

test("ordinary known-Scope binding reads its canonical pair in one native data statement", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(original) })
  await runtime.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: original.projectID,
      local: null,
      time: { created: 1, updated: 1 },
    })
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const session = await Session.create({ organization: original, workspace: null, environmentID: null })
        const expected = await binding(session.id, original.orgID, scope.id)
        expect(expected?.rootSessionID).toBe(session.id)
        await Storage.transaction(async (tx) => {
          const raw = tx.raw
          const query = raw.query
          let dataStatements = 0
          raw.query = <Row extends SqlRow>(statement: string, values?: SqlValue[], options?: SqlQueryOptions) => {
            if (statement.startsWith("SELECT ") && statement.includes("FROM storage_records")) dataStatements++
            return query<Row>(statement, values, options)
          }
          let selected: Awaited<ReturnType<typeof binding>>
          try {
            selected = await binding(session.id, original.orgID, scope.id)
          } finally {
            raw.query = query
          }
          expect(selected).toEqual(expected)
          expect(dataStatements).toBe(1)
        })
      },
    })
  })
})

test("ordinary known-Scope binding retains current driver facts and dynamic owner validation", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(original) })
  await using other = await testRuntime({ register: () => registerSessionSchema(original) })
  await runtime.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: original.projectID,
      local: null,
      time: { created: 1, updated: 1 },
    })
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const session = await Session.create({ organization: original, workspace: null, environmentID: null })
        const selector = { scopeID: scope.id, sessionID: session.id }
        const key = StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(session.id))
        const before = await binding(session.id, original.orgID, scope.id)
        const discarded = new Error("Discard the current driver change")
        expect(
          await rejected(
            Storage.transaction(async () => {
              await Storage.update<Record<string, unknown>>(key, (raw) => {
                raw.organization = { ...original, driverRuntimeID: "next-runtime", bindingEpoch: 2 }
              })
              const current = await binding(session.id, original.orgID, scope.id)
              expect(current?.binding).toEqual({ ...original, driverRuntimeID: "next-runtime", bindingEpoch: 2 })
              expect(await binding(session.id, original.orgID)).toEqual(current)
              throw discarded
            }),
          ),
        ).toBe(discarded)
        expect(await binding(session.id, original.orgID, scope.id)).toEqual(before)
        const malformed = await rejected(
          Storage.transaction(async () => {
            await Storage.update<Record<string, unknown>>(key, (raw) => {
              raw.organization = { ...original, bindingEpoch: "invalid" }
            })
            expect((await Core.storedInfoIfPresent(selector))?.raw.organization).toMatchObject({
              bindingEpoch: "invalid",
            })
            await binding(session.id, original.orgID, scope.id)
          }),
        )
        expect(malformed).toBeInstanceOf(z.ZodError)
        expect(await binding(session.id, original.orgID, scope.id)).toEqual(before)
        expect(await other.run(() => binding(session.id, original.orgID, scope.id))).toBeUndefined()
        expect(await binding(session.id, original.orgID, scope.id)).toEqual(before)
      },
    })
  })
})

test("native binding rejects a persisted Cortex parent cycle within its original read window", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(original) })
  await runtime.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: original.projectID,
      local: null,
      time: { created: 1, updated: 1 },
    })
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const sessions = [
          await Session.create({ organization: original, workspace: null, environmentID: null }),
          await Session.create({ organization: original, workspace: null, environmentID: null }),
        ]
        const entries: Array<{ key: string[]; value: unknown }> = []
        const restore: Array<{ key: string[]; value: unknown }> = []
        for (const [index, session] of sessions.entries()) {
          const parent = sessions[1 - index]!
          const stored = await Core.storedInfo({ scopeID: scope.id, sessionID: session.id })
          const cortex = {
            taskID: `cycle-task-${index}`,
            parentSessionID: parent.id,
            parentMessageID: Identifier.ascending("message"),
            description: "Persisted cyclic ancestry fixture",
            agent: "binding-cycle-fixture",
            startedAt: 1,
            completedAt: 2,
            status: "completed" as const,
          }
          const raw = { ...stored.raw, parentID: parent.id, cortex }
          const parsed = Session.Info.parse({ ...raw, workspace: null })
          const infoKey = StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(session.id))
          const indexKey = StoragePath.sessionIndex(Identifier.asSessionID(session.id))
          const [indexValue] = await Storage.readMany([indexKey])
          entries.push({ key: infoKey, value: raw }, { key: indexKey, value: Session.toIndex(parsed) })
          restore.push({ key: infoKey, value: stored.raw }, { key: indexKey, value: indexValue })
        }
        await Storage.withMigrationRecords(() => Storage.transaction((tx) => tx.writeMany(entries)))
        try {
          for (const [index, session] of sessions.entries()) {
            const stored = await Core.storedInfo({ scopeID: scope.id, sessionID: session.id })
            expect(stored.info.parentID).toBe(sessions[1 - index]!.id)
            expect(Session.Info.parse({ ...stored.raw, workspace: null }).cortex?.parentSessionID).toBe(
              stored.info.parentID,
            )
          }
          for (const read of [binding, mutationBinding]) {
            const readMany = Storage.readMany
            let canonicalReads = 0
            const budget = new Error("Cyclic native ancestry exceeded its original canonical read window")
            Storage.readMany = <T>(keys: string[][]) => {
              if (
                keys.length === 2 &&
                keys[0]?.[0] === "session_index" &&
                sessions.some((session) => keys[0]?.[1] === session.id) &&
                keys[1]?.[0] === "sessions" &&
                keys[1]?.[1] === scope.id &&
                keys[1]?.[3] === "info"
              ) {
                canonicalReads++
                if (canonicalReads > sessions.length + 1) return Promise.reject(budget)
              }
              return readMany<T>(keys)
            }
            let outcome:
              { kind: "resolved"; value: Awaited<ReturnType<typeof read>> } | { kind: "rejected"; error: unknown }
            try {
              outcome = await read(sessions[0]!.id, original.orgID, scope.id).then(
                (value) => ({ kind: "resolved" as const, value }),
                (error: unknown) => ({ kind: "rejected" as const, error }),
              )
            } finally {
              Storage.readMany = readMany
            }
            expect({ outcome, canonicalReads }).toEqual({
              outcome: { kind: "resolved", value: undefined },
              canonicalReads: sessions.length + 1,
            })
          }
        } finally {
          await Storage.withMigrationRecords(() => Storage.transaction((tx) => tx.writeMany(restore)))
        }
        expect((await binding(sessions[0]!.id, original.orgID, scope.id))?.rootSessionID).toBe(sessions[0]!.id)
        expect((await binding(sessions[1]!.id, original.orgID, scope.id))?.rootSessionID).toBe(sessions[1]!.id)
      },
    })
  })
})
