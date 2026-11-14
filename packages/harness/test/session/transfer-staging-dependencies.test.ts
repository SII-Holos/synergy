import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferStaging as Staging } from "../../src/session/transfer-staging"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"
import { Storage } from "../../src/storage/storage"

const owner: Owners.Contribution = {
  version: 1,
  reads: [1],
  applies: () => true,
  async inspect() {
    return { requirements: [], children: (async function* () {})() }
  },
  async freeze() {},
  async *export() {
    yield* []
  },
  async validate() {},
  async publish() {},
}

test("declared staged dependencies are read-only and bound to one handoff member before native Snapshot root enumeration", async () => {
  await using directory = await tmpdir()
  const dependencies = ["session-core"]
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      await Bun.write(path.join(directory.path, hash), bytes)
    },
    async get(hash: string, maximumBytes: number) {
      const file = Bun.file(path.join(directory.path, hash))
      if (file.size > maximumBytes) throw new Error("Oversized object")
      return new Uint8Array(await file.arrayBuffer())
    },
  }
  await using runtime = await testRuntime({
    register() {
      Core.register()
      Owners.register("snapshots", { ...owner, stagedDependencies: dependencies })
      Owners.register("unrelated", owner)
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const other = await Session.create({ workspace: null, environmentID: null })
        const roots = ["a".repeat(40), "b".repeat(40)]
        const root = await Stream.write({
          store,
          owners: Owners.versions(["session-core", "snapshots", "unrelated"]),
          entries: (async function* () {
            for (const [member, hash] of [
              [session, roots[0]],
              [other, roots[1]],
            ] as const) {
              const key = ["sessions", "home", member.id, "info"]
              yield {
                id: `info-${member.id}`,
                kind: "record" as const,
                metadata: { transferOwner: "session-core", transferSessionID: member.id, key },
                content: (async function* () {
                  yield Buffer.from(JSON.stringify(await Storage.read(key)))
                })(),
              }
              yield {
                id: `snapshot-${member.id}`,
                kind: "record" as const,
                metadata: {
                  transferOwner: "session-core",
                  transferSessionID: member.id,
                  key: ["sessions", "home", member.id, "messages", "message", "parts", "part"],
                },
                content: (async function* () {
                  yield Buffer.from(JSON.stringify({ type: "snapshot", snapshot: hash }))
                })(),
              }
            }
            yield {
              id: "unrelated",
              kind: "record" as const,
              metadata: { transferOwner: "unrelated", transferSessionID: session.id, key: ["unrelated", session.id] },
              content: (async function* () {
                yield Buffer.from(JSON.stringify({ secret: "not a declared dependency" }))
              })(),
            }
          })(),
        })
        await Staging.receive({ handoffID: "snapshot-related", root, store })
        const context = await Staging.context({
          ownerID: "snapshots",
          handoffID: "snapshot-related",
          session,
          rootSessionID: session.id,
          signal: new AbortController().signal,
          mapping: {},
        })
        const related = context.staged.relatedRecords!("session-core")
        const found: string[] = []
        for await (const hash of Core.snapshotRoots(session, related)) found.push(hash)
        expect(found).toEqual([roots[0]])
        const rows: Owners.StagedRecord[] = []
        for await (const row of context.staged.relatedRecords!("session-core")) rows.push(row)
        expect(rows).toHaveLength(2)
        expect(rows[0]).not.toHaveProperty("publish")
        expect(
          await context.staged.relatedRecord!("session-core", ["sessions", "home", session.id, "info"]),
        ).toBeDefined()
        expect(
          await context.staged.relatedRecord!("session-core", ["sessions", "home", other.id, "info"]),
        ).toBeUndefined()
        await expect(context.staged.relatedRecord!("unrelated", ["unrelated", session.id])).rejects.toThrow("declared")
        dependencies.push("unrelated")
        await expect(context.staged.relatedRecords!("unrelated")[Symbol.asyncIterator]().next()).rejects.toThrow(
          "declared",
        )
        const unrelated = await Staging.context({ ...context, ownerID: "unrelated" })
        await expect(unrelated.staged.relatedRecords!("session-core")[Symbol.asyncIterator]().next()).rejects.toThrow(
          "declared",
        )
        const otherRoot = await Stream.write({
          store,
          owners: Owners.versions(["session-core", "snapshots"]),
          entries: (async function* () {
            for (const [index, record] of [
              {
                key: ["sessions", "home", session.id, "info"],
                value: await Storage.read(["sessions", "home", session.id, "info"]),
              },
              {
                key: ["sessions", "home", session.id, "messages", "message", "parts", "part"],
                value: { type: "snapshot", snapshot: roots[1] },
              },
            ].entries())
              yield {
                id: `other-${index}`,
                kind: "record" as const,
                metadata: { transferOwner: "session-core", transferSessionID: session.id, key: record.key },
                content: (async function* () {
                  yield Buffer.from(JSON.stringify(record.value))
                })(),
              }
          })(),
        })
        await Staging.receive({ handoffID: "another-snapshot-package", root: otherRoot, store })
        const second = await Staging.context({
          ...context,
          handoffID: "another-snapshot-package",
          ownerID: "snapshots",
        })
        const secondRoots: string[] = []
        for await (const hash of Core.snapshotRoots(session, second.staged.relatedRecords!("session-core")))
          secondRoots.push(hash)
        expect(secondRoots).toEqual([roots[1]])
        const firstRoots: string[] = []
        for await (const hash of Core.snapshotRoots(session, context.staged.relatedRecords!("session-core")))
          firstRoots.push(hash)
        expect(firstRoots).toEqual([roots[0]])
        const missingRoot = await Stream.write({
          store,
          owners: { snapshots: 1 },
          entries: (async function* () {
            yield* []
          })(),
        })
        await Staging.receive({ handoffID: "missing-core-package", root: missingRoot, store })
        const missing = await Staging.context({ ...context, handoffID: "missing-core-package", ownerID: "snapshots" })
        await expect(missing.staged.relatedRecords!("session-core")[Symbol.asyncIterator]().next()).rejects.toThrow(
          "absent",
        )
        const foreign = Core.snapshotRoots(
          session,
          (async function* () {
            yield {
              key: ["sessions", "home", other.id, "messages", "message", "parts", "part"],
              value: { type: "snapshot", snapshot: roots[1] },
            }
          })(),
        )
        await expect(foreign.next()).rejects.toThrow("another")
      },
    }),
  )
})
