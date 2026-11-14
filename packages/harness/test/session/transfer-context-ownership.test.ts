import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore, StoreTransaction, type RecordQuery } from "../../src/storage/transactional-store"
import { Session } from "../../src/session"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"
import { SessionTransferStaging as Staging } from "../../src/session/transfer-staging"

function registerProbe() {
  const probe: Owners.Contribution = {
    version: 1,
    reads: [1],
    applies: () => true,
    async inspect() {
      return { requirements: [], children: (async function* () {})() }
    },
    async freeze() {},
    async *export() {},
    async validate() {},
    async publish() {},
  }
  Owners.register("context-probe", { ...probe, stagedDependencies: ["context-dependency"] })
  Owners.register("context-dependency", probe)
}
const recordKey = ["context-probe", "record"]
const binaryKey = ["context-probe", "binary"]
const dependencyKey = ["context-dependency", "record"]
async function stageProbe(handoffID: string, session: Readonly<Session.Info>, payload: string) {
  const objects = new Map<string, Uint8Array>()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      objects.set(hash, bytes.slice())
    },
    async get(hash: string) {
      const bytes = objects.get(hash)
      if (!bytes) throw new Error("Missing object")
      return bytes
    },
  }
  const root = await Stream.write({
    store,
    owners: { "context-probe": 1, "context-dependency": 1 },
    entries: (async function* () {
      for (const [id, ownerID, key] of [
        ["record", "context-probe", recordKey],
        ["dependency", "context-dependency", dependencyKey],
      ] as const)
        yield {
          id,
          kind: "record" as const,
          metadata: { key: [...key], transferOwner: ownerID, transferSessionID: session.id },
          content: (async function* () {
            yield new TextEncoder().encode(JSON.stringify({ payload }))
          })(),
        }
      yield {
        id: "binary",
        kind: "artifact" as const,
        metadata: { key: binaryKey, transferOwner: "context-probe", transferSessionID: session.id },
        content: (async function* () {
          yield new Uint8Array(4 * 1024 * 1024 + 19).fill(payload.charCodeAt(0))
        })(),
      }
    })(),
  })
  await Staging.receive({ handoffID, root, store })
}

test("a staged native owner context cannot read another Store in the same Runtime", async () => {
  await using directory = await tmpdir()
  await using runtime = await testRuntime({
    register() {
      Owners.register("ownership-probe", {
        version: 1,
        reads: [1],
        applies: () => true,
        async inspect() {
          return { requirements: [], children: (async function* () {})() }
        },
        async freeze() {},
        async *export() {},
        async validate() {},
        async publish() {},
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null, environmentID: null })
        const handoffID = "same-handoff-in-different-native-store"
        const key = ["ownership-probe", "payload"]
        async function stage(payload: string) {
          const objects = new Map<string, Uint8Array>()
          const store = {
            async put(hash: string, bytes: Uint8Array) {
              objects.set(hash, bytes.slice())
            },
            async get(hash: string) {
              const bytes = objects.get(hash)
              if (!bytes) throw new Error("Missing object")
              return bytes
            },
          }
          const root = await Stream.write({
            store,
            owners: { "ownership-probe": 1 },
            entries: (async function* () {
              yield {
                id: "payload",
                kind: "record" as const,
                metadata: { key, transferOwner: "ownership-probe", transferSessionID: session.id },
                content: (async function* () {
                  yield new TextEncoder().encode(JSON.stringify({ payload }))
                })(),
              }
            })(),
          })
          await Staging.receive({ handoffID, root, store })
        }
        await stage("original native store")
        const context = await Staging.context({
          ownerID: "ownership-probe",
          session,
          rootSessionID: session.id,
          handoffID,
          mapping: {},
          signal: new AbortController().signal,
        })
        expect((await context.staged.record(key))?.value).toEqual({ payload: "original native store" })
        const foreign = await TransactionalStore.open({
          backend: "sqlite",
          filename: path.join(directory.path, "foreign.sqlite"),
          namespace: "foreign",
        })
        try {
          await Storage.provide(
            { store: foreign, artifactDirectory: path.join(directory.path, "artifacts") },
            async () => {
              await stage("foreign private namespace bytes")
              await expect(context.staged.record(key)).rejects.toThrow("storage owner")
            },
          )
        } finally {
          await foreign.close()
        }
      },
    }),
  )
})

test("context creation fixes selectors, Session metadata and mapping before its first native read", async () => {
  await using runtime = await testRuntime({ register: registerProbe })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const original = await Session.create({ workspaceID: null, environmentID: null })
        const other = await Session.create({ workspaceID: null, environmentID: null })
        await stageProbe("original-context", original, "original")
        await stageProbe("replacement-context", other, "replacement")
        const session = { ...original, scope: { ...original.scope }, futureOwner: { exact: "preserved" } }
        const input = {
          ownerID: "context-probe",
          handoffID: "original-context",
          rootSessionID: session.id,
          session,
          mapping: { workspaceIDs: { old: "original-workspace" } },
          signal: new AbortController().signal,
        }
        const entered = Promise.withResolvers<void>()
        const proceed = Promise.withResolvers<void>()
        const read = Storage.read
        const held = spyOn(Storage, "read").mockImplementation(
          async <T>(key: string[], options?: { silentNotFound?: boolean }) => {
            const result = await read<T>(key, options)
            if (key[0] === "session_transfer_staging" && key[1] === "original-context" && key[2] === "state") {
              entered.resolve()
              await proceed.promise
            }
            return result
          },
        )
        const preparing = Staging.context(input)
        void preparing.catch(() => {})
        try {
          await entered.promise
          input.ownerID = "context-dependency"
          input.handoffID = "replacement-context"
          input.rootSessionID = other.id
          session.id = other.id
          session.scope.id = "replacement-scope"
          session.futureOwner.exact = "changed"
          input.mapping.workspaceIDs.old = "replacement-workspace"
          input.signal = AbortSignal.abort(new Error("replacement observer"))
          proceed.resolve()
          const context = await preparing
          expect(context.handoffID).toBe("original-context")
          expect(context.rootSessionID).toBe(original.id)
          expect(context.session.id).toBe(original.id)
          expect(context.session.scope.id).toBe(original.scope.id)
          expect(context.session).toMatchObject({ futureOwner: { exact: "preserved" } })
          expect(context.mapping).toEqual({ workspaceIDs: { old: "original-workspace" } })
          expect((await context.staged.record(recordKey))?.value).toEqual({ payload: "original" })
          expect(() => {
            context.session.scope.id = "cannot-retarget"
          }).toThrow()
        } finally {
          proceed.resolve()
          await Promise.allSettled([preparing])
          held.mockRestore()
        }
      },
    }),
  )
})

test("replacing a caller's signal during the native state read cannot bypass its original cancellation", async () => {
  await using runtime = await testRuntime({ register: registerProbe })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null, environmentID: null })
        await stageProbe("cancel-context", session, "original")
        const abort = new AbortController()
        const input = {
          ownerID: "context-probe",
          handoffID: "cancel-context",
          rootSessionID: session.id,
          session,
          mapping: {},
          signal: abort.signal,
        }
        const entered = Promise.withResolvers<void>()
        const proceed = Promise.withResolvers<void>()
        const read = Storage.read
        const held = spyOn(Storage, "read").mockImplementation(
          async <T>(key: string[], options?: { silentNotFound?: boolean }) => {
            const result = await read<T>(key, options)
            if (key[0] === "session_transfer_staging" && key[1] === "cancel-context" && key[2] === "state") {
              entered.resolve()
              await proceed.promise
            }
            return result
          },
        )
        const preparing = Staging.context(input)
        void preparing.catch(() => {})
        const reason = new Error("original context cancelled")
        try {
          await entered.promise
          input.signal = new AbortController().signal
          abort.abort(reason)
          proceed.resolve()
          await expect(preparing).rejects.toBe(reason)
        } finally {
          proceed.resolve()
          await Promise.allSettled([preparing])
          held.mockRestore()
        }
      },
    }),
  )
})

test("context reads and deferred artifact iterators reject foreign Stores and artifact settings before yielding bytes", async () => {
  await using directory = await tmpdir()
  await using runtime = await testRuntime({ register: registerProbe })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null, environmentID: null })
        const handoffID = "deferred-context"
        await stageProbe(handoffID, session, "original")
        const context = await Staging.context({
          ownerID: "context-probe",
          handoffID,
          session,
          rootSessionID: session.id,
          mapping: {},
          signal: new AbortController().signal,
        })
        const artifact = await context.staged.artifact?.(binaryKey)
        if (!artifact) throw new Error("Missing actual staged artifact")
        const current = Storage.current()
        const foreign = await TransactionalStore.open({
          backend: "sqlite",
          filename: path.join(directory.path, "foreign.sqlite"),
          namespace: "foreign",
        })
        const foreignHandle = { store: foreign, artifactDirectory: path.join(directory.path, "foreign-artifacts") }
        try {
          await Storage.provide(foreignHandle, () => stageProbe(handoffID, session, "foreign"))
          for (const handle of [
            foreignHandle,
            { store: current.store, artifactDirectory: path.join(directory.path, "wrong-artifacts") },
          ]) {
            const records = context.staged.records()[Symbol.asyncIterator]()
            const related = context.staged.relatedRecords!("context-dependency")[Symbol.asyncIterator]()
            const artifacts = context.staged.artifacts()[Symbol.asyncIterator]()
            const bytes = artifact.read()[Symbol.asyncIterator]()
            const started = artifact.read()[Symbol.asyncIterator]()
            expect((await started.next()).done).toBe(false)
            try {
              await Storage.provide(handle, async () => {
                await expect(context.staged.record(recordKey)).rejects.toThrow("storage owner")
                await expect(context.staged.relatedRecord!("context-dependency", dependencyKey)).rejects.toThrow(
                  "storage owner",
                )
                await expect(context.staged.ownerVersion!("context-dependency")).rejects.toThrow("storage owner")
                await expect(context.staged.artifact!(binaryKey)).rejects.toThrow("storage owner")
                await expect(records.next()).rejects.toThrow("storage owner")
                await expect(related.next()).rejects.toThrow("storage owner")
                await expect(artifacts.next()).rejects.toThrow("storage owner")
                await expect(bytes.next()).rejects.toThrow("storage owner")
                await expect(started.next()).rejects.toThrow("storage owner")
                await expect(artifact.publish(["must-not-publish"])).rejects.toThrow("storage owner")
              })
            } finally {
              for (const iterator of [records, related, artifacts, bytes, started]) await iterator.return?.()
            }
          }
          expect((await context.staged.record(recordKey))?.value).toEqual({ payload: "original" })
        } finally {
          await foreign.close()
        }
      },
    }),
  )
})

test("an escaped subsequent artifact next cannot advance the native reader before ownership rejects it", async () => {
  await using directory = await tmpdir()
  await using runtime = await testRuntime({ register: registerProbe })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null, environmentID: null })
        const handoffID = "native-reader-guard"
        await stageProbe(handoffID, session, "original")
        const context = await Staging.context({
          ownerID: "context-probe",
          handoffID,
          session,
          rootSessionID: session.id,
          mapping: {},
          signal: new AbortController().signal,
        })
        const artifact = await context.staged.artifact!(binaryKey)
        if (!artifact) throw new Error("Missing actual staged artifact")
        let reads = 0
        const restore: Array<() => void> = []
        const read = Storage.readBinaryStream
        const held = spyOn(Storage, "readBinaryStream").mockImplementation((key, options) => {
          const reader = read(key, options)
          const advance = reader.next.bind(reader)
          const watched = spyOn(reader, "next").mockImplementation((...input) => {
            reads++
            return advance(...input)
          })
          restore.push(() => watched.mockRestore())
          return reader
        })
        const reader = artifact.read()[Symbol.asyncIterator]()
        try {
          expect((await reader.next()).done).toBe(false)
          expect(reads).toBe(1)
          const handle = Storage.current()
          await Storage.provide(
            { ...handle, artifactDirectory: path.join(directory.path, "wrong-artifacts") },
            async () => {
              await expect(reader.next()).rejects.toThrow("storage owner")
              expect(reads).toBe(1)
            },
          )
        } finally {
          await reader.return?.()
          held.mockRestore()
          for (const reset of restore) reset()
        }
      },
    }),
  )
})

test("an escaped record iterator cannot fetch its next native metadata page before ownership rejects it", async () => {
  await using directory = await tmpdir()
  await using runtime = await testRuntime({ register: registerProbe })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null, environmentID: null })
        const handoffID = "native-record-page-guard"
        const objects = new Map<string, Uint8Array>()
        const store = {
          async put(hash: string, bytes: Uint8Array) {
            objects.set(hash, bytes.slice())
          },
          async get(hash: string) {
            const bytes = objects.get(hash)
            if (!bytes) throw new Error("Missing object")
            return bytes
          },
        }
        const root = await Stream.write({
          store,
          owners: { "context-probe": 1, "context-dependency": 1 },
          entries: (async function* () {
            for (let index = 0; index < 129; index++)
              yield {
                id: `row${index}`,
                kind: "record" as const,
                metadata: {
                  key: ["context-probe", String(index)],
                  transferOwner: "context-probe",
                  transferSessionID: session.id,
                },
                content: (async function* () {
                  yield new TextEncoder().encode(JSON.stringify({ index }))
                })(),
              }
          })(),
        })
        await Staging.receive({ handoffID, root, store })
        const context = await Staging.context({
          ownerID: "context-probe",
          handoffID,
          session,
          rootSessionID: session.id,
          mapping: {},
          signal: new AbortController().signal,
        })
        let pages = 0
        const query = StoreTransaction.prototype.query
        const held = spyOn(StoreTransaction.prototype, "query").mockImplementation(async function <T>(
          this: StoreTransaction,
          input: RecordQuery,
        ) {
          if (input.prefix?.[0] === "session_transfer_staging") pages++
          return (query<T>).call(this, input)
        })
        const rows = context.staged.records()[Symbol.asyncIterator]()
        try {
          for (let index = 0; index < 128; index++)
            if ((await rows.next()).done) throw new Error("Native first page ended early")
          expect(pages).toBe(1)
          const handle = Storage.current()
          await Storage.provide(
            { ...handle, artifactDirectory: path.join(directory.path, "wrong-artifacts") },
            async () => {
              await expect(rows.next()).rejects.toThrow("storage owner")
              expect(pages).toBe(1)
            },
          )
        } finally {
          await rows.return?.()
          held.mockRestore()
        }
      },
    }),
  )
})
