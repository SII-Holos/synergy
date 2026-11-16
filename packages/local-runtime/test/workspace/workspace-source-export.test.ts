import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspacePortableSchema as Schema } from "@ericsanchezok/synergy-harness/session/workspace-portable-schema"
import {
  SessionTransferCore as Core,
  SessionTransferSource as Source,
  SessionTransferWorkspaces as Files,
  SessionTransferStream as Stream,
  SessionTransferEpochs as Epochs,
  SessionTransferSnapshots as Snapshots,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { SnapshotStore } from "@ericsanchezok/synergy-harness/session/snapshot-store"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { registerWorkspace } from "../../src/register-workspace"
import { NativeSessionTransferPhysical as Physical } from "../../src/session-transfer-physical"
import { NativeWorkspacePortableTree } from "../../src/workspace/portable-tree"

function objects() {
  const values = new Map<string, Uint8Array>()
  return {
    async put(hash: string, bytes: Uint8Array) {
      values.set(hash, bytes.slice())
    },
    async get(hash: string, maximumBytes: number) {
      const value = values.get(hash)
      if (!value || value.length > maximumBytes) throw new Error("Missing bounded frame")
      return value
    },
  }
}

test("the native source exports every member and only its own current Workspace partition with a recomputable closure", async () => {
  await using directory = await tmpdir()
  const files = path.join(directory.path, "current")
  await fs.mkdir(files)
  await Bun.write(path.join(files, "model.bin"), new Uint8Array([0, 255, 12, 77]))
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") }))
      Core.register()
      Files.register()
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const workspace = await WorkspaceBinding.register("home", files)
        const root = await Session.create({ workspaceID: null, environmentID: null })
        const first = await Session.create({ parentID: root.id, workspaceID: workspace.id, environmentID: null })
        const second = await Session.create({ parentID: root.id, workspaceID: workspace.id, environmentID: null })
        const sessions = [root, first, second]
        const binding = {
          sessionID: root.id,
          scopeID: "home",
          handoffID: "source-file-partitions",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const values = new Map<string, Uint8Array>()
        const store = {
          async put(hash: string, bytes: Uint8Array) {
            values.set(hash, bytes.slice())
          },
          async get(hash: string, maximumBytes: number) {
            const value = values.get(hash)
            if (!value || value.length > maximumBytes) throw new Error("Missing bounded frame")
            return value
          },
        }
        const signal = new AbortController().signal
        let lease: Physical.Lease | undefined
        try {
          const prepared = await Source.prepare({
            binding,
            store,
            signal,
            async verify() {},
            async beforeFreeze() {
              lease = await Physical.begin({ ...binding, rootSessionID: root.id })
              await Physical.withCapture(lease, async () => {
                expect(await Files.capture({ binding, signal })).toMatchObject({
                  members: 3,
                  workspaces: 1,
                  references: 2,
                  entries: 1,
                  bytes: 4,
                })
              })
            },
          })
          const captured = await Files.receipt(binding)
          if (!captured) throw new Error("Missing native file receipt")
          const rows = new Map<string, Schema.Row>()
          const members = new Set<string>()
          const copies = new Set<string>()
          const readDirectory = path.join(directory.path, "readers")
          await fs.mkdir(readDirectory)
          await using reader = await Stream.open({ root: prepared.root, store, directory: readDirectory, signal })
          for await (const entry of reader.entries()) {
            const chunks: Uint8Array[] = []
            for await (const chunk of entry.content) chunks.push(chunk)
            if (entry.metadata.transferOwner !== "session-workspaces") continue
            const session = sessions.find((value) => value.id === entry.metadata.transferSessionID)
            if (!session) throw new Error("Portable member is outside the actual cohort")
            const key = entry.metadata.key
            if (!Array.isArray(key) || key.some((value) => typeof value !== "string"))
              throw new Error("Malformed portable key")
            const parsedKey = key.map((value) => {
              if (typeof value !== "string") throw new Error("Malformed portable key")
              return value
            })
            expect(parsedKey.slice(0, 3)).toEqual(Schema.portablePrefix(session))
            const bytes = Buffer.concat(chunks)
            if (entry.kind === "record") {
              const row = Schema.parseRecord(
                session,
                parsedKey,
                JSON.parse(bytes.toString("utf8")),
                session.workspaceID ?? undefined,
              )
              if (row.kind === "member") members.add(row.value.sessionID)
              if (session.id === root.id) expect(row.kind).toBe("member")
              const previous = rows.get(Schema.order(row))
              if (previous) expect(previous).toEqual(row)
              else rows.set(Schema.order(row), row)
            } else {
              expect(session.id).not.toBe(root.id)
              const hash = parsedKey.at(-1)
              if (!hash) throw new Error("Portable frame has no content hash")
              expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash)
              copies.add(session.id)
            }
          }
          expect(reader.verified()).toBe(true)
          expect([...members].sort()).toEqual(sessions.map((value) => value.id).sort())
          expect([...copies].sort()).toEqual([first.id, second.id].sort())
          const sorted = [...rows.values()].sort((a, b) =>
            Buffer.compare(Buffer.from(Schema.order(a)), Buffer.from(Schema.order(b))),
          )
          expect(
            await Schema.digest(
              binding,
              (async function* () {
                yield* sorted
              })(),
              signal,
            ),
          ).toEqual(captured)
        } finally {
          if (lease) await Physical.release(lease)
        }
      },
    }),
  )
}, 15000)

test("a draining retry recaptures current bytes after a failed final native frame", async () => {
  await using directory = await tmpdir()
  const files = path.join(directory.path, "current")
  await fs.mkdir(files)
  await Bun.write(path.join(files, "source.txt"), "old")
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") }))
      Core.register()
      Files.register()
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const workspace = await WorkspaceBinding.register("home", files)
        const session = await Session.create({ workspaceID: workspace.id, environmentID: null })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "recapture-draining",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const signal = new AbortController().signal
        const store = objects()
        const reason = new Error("First final native frame failed")
        let rejectFinal = false
        const verify = ServerProcessLock.verifyOwnership
        using fault = spyOn(ServerProcessLock, "verifyOwnership").mockImplementation(async (proof) => {
          if (rejectFinal) {
            rejectFinal = false
            throw reason
          }
          await verify(proof)
        })
        using capture = spyOn(NativeWorkspacePortableTree, "capture")
        let lease: Physical.Lease | undefined
        let first = true
        const beforeFreeze = async () => {
          lease ??= await Physical.begin({ ...binding, rootSessionID: session.id })
          await Physical.withCapture(lease, async () => {
            await Files.capture({ binding, signal })
            if (first) {
              first = false
              rejectFinal = true
            }
          })
        }
        try {
          await expect(Source.prepare({ binding, store, signal, async verify() {}, beforeFreeze })).rejects.toBe(reason)
          const old = await Files.receipt(binding)
          expect((await Epochs.inspect(binding)).phase).toBe("draining")
          await Bun.write(path.join(files, "source.txt"), "new captured bytes")
          await Source.prepare({ binding, store, signal, async verify() {}, beforeFreeze })
          expect(capture).toHaveBeenCalledTimes(2)
          expect((await Files.receipt(binding))?.hash).not.toBe(old?.hash)
          expect(await Files.receipt(binding)).toMatchObject({ bytes: Buffer.byteLength("new captured bytes") })
        } finally {
          if (lease) await Physical.release(lease)
        }
      },
    }),
  )
}, 15000)

test("historical Workspace identities retain their generation without reading a retired directory", async () => {
  await using directory = await tmpdir()
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") }))
      Core.register()
      Snapshots.register()
      Files.register()
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null, environmentID: null })
        const operation = await SnapshotStore.resolveRepository("home", session.id)
        await SnapshotStore.initialize(operation)
        const blob = await SnapshotStore.command(
          operation.repository,
          ["hash-object", "-w", "--stdin"],
          undefined,
          "historical bytes",
        )
        const tree = await SnapshotStore.command(
          operation.repository,
          ["mktree"],
          undefined,
          `100644 blob ${blob}\thistory.txt\n`,
        )
        await SnapshotStore.retainMany("home", session.id, [tree])
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          rootID: messageID,
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
          time: { created: 1 },
        })
        const retired = path.join(directory.path, "retired-directory-does-not-exist")
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "snapshot",
          snapshot: tree,
          workspace: { id: "retired-workspace", generation: 7, root: retired },
        })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "historical-workspace-ref",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const signal = new AbortController().signal
        using capture = spyOn(NativeWorkspacePortableTree, "capture")
        let lease: Physical.Lease | undefined
        try {
          await Source.prepare({
            binding,
            store: objects(),
            signal,
            async verify() {},
            async beforeFreeze() {
              lease = await Physical.begin({ ...binding, rootSessionID: session.id })
              await Physical.withCapture(lease, () => Files.capture({ binding, signal }))
            },
          })
          expect(await Files.receipt(binding)).toMatchObject({
            members: 1,
            references: 1,
            workspaces: 0,
            entries: 0,
            bytes: 0,
          })
          expect(capture).not.toHaveBeenCalled()
          expect(await fs.exists(retired)).toBe(false)
        } finally {
          if (lease) await Physical.release(lease)
        }
      },
    }),
  )
}, 15000)

test("an omitted native file callback cannot export a zero-Workspace cohort and remains explicitly cancellable", async () => {
  await using directory = await tmpdir()
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") }))
      Core.register()
      Files.register()
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null, environmentID: null })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "omitted-native-callback",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const signal = new AbortController().signal
        const store = objects()
        await expect(Source.prepare({ binding, store, signal, async verify() {} })).rejects.toThrow(
          "completed native file capture",
        )
        expect(await Files.receipt(binding)).toBeUndefined()
        expect((await Epochs.inspect(binding)).phase).toBe("frozen")
        expect(await Source.cancel({ binding, store, signal, async verify() {} })).toMatchObject({ members: 1 })
        expect((await Epochs.inspect(binding)).phase).toBe("cancelled")
        expect((await Session.get(session.id)).paused).toBeDefined()
        const empty = await Session.create({ workspaceID: null, environmentID: null })
        const next = { ...binding, sessionID: empty.id, handoffID: "actual-empty-native-capture" }
        let lease: Physical.Lease | undefined
        try {
          await Source.prepare({
            binding: next,
            store,
            signal,
            async verify() {},
            async beforeFreeze() {
              lease = await Physical.begin({ ...next, rootSessionID: empty.id })
              await Physical.withCapture(lease, () => Files.capture({ binding: next, signal }))
            },
          })
          expect(await Files.receipt(next)).toMatchObject({
            members: 1,
            workspaces: 0,
            references: 0,
            entries: 0,
            bytes: 0,
          })
        } finally {
          if (lease) await Physical.release(lease)
        }
      },
    }),
  )
})

test("failed native capture candidates cannot become reusable by freezing through an empty retry", async () => {
  await using directory = await tmpdir()
  const files = path.join(directory.path, "current")
  await fs.mkdir(files)
  await Bun.write(path.join(files, "source.txt"), "original file bytes")
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") }))
      Core.register()
      Files.register()
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const workspace = await WorkspaceBinding.register("home", files)
        const session = await Session.create({ workspaceID: workspace.id, environmentID: null })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "failed-file-candidate",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const signal = new AbortController().signal
        const store = objects()
        const reason = new Error("Native final frame validation failed")
        let rejectFinal = false
        const verify = ServerProcessLock.verifyOwnership
        using fault = spyOn(ServerProcessLock, "verifyOwnership").mockImplementation(async (proof) => {
          if (rejectFinal) {
            rejectFinal = false
            throw reason
          }
          await verify(proof)
        })
        using capture = spyOn(NativeWorkspacePortableTree, "capture")
        let lease: Physical.Lease | undefined
        try {
          await expect(
            Source.prepare({
              binding,
              store,
              signal,
              async verify() {},
              async beforeFreeze() {
                lease = await Physical.begin({ ...binding, rootSessionID: session.id })
                await Physical.withCapture(lease, async () => {
                  await Files.capture({ binding, signal })
                  rejectFinal = true
                })
              },
            }),
          ).rejects.toBe(reason)
          expect((await Epochs.inspect(binding)).phase).toBe("draining")
          const original = await Files.receipt(binding)
          await Bun.write(path.join(files, "source.txt"), "changed file bytes")
          await expect(
            Source.prepare({
              binding,
              store,
              signal,
              async verify() {},
              async beforeFreeze() {
                if (!lease) throw new Error("Missing native lease")
                await Physical.withCapture(lease, async () => {})
              },
            }),
          ).rejects.toThrow("capture attempt")
          expect((await Epochs.inspect(binding)).phase).toBe("frozen")
          await expect(
            Source.prepare({
              binding,
              store,
              signal,
              async verify() {},
              async beforeFreeze() {
                if (!lease) throw new Error("Missing native lease")
                await Physical.withCapture(lease, () => Files.capture({ binding, signal }))
              },
            }),
          ).rejects.toThrow("no completed immutable Workspace closure")
          expect(capture).toHaveBeenCalledTimes(1)
          expect(await Files.receipt(binding)).toEqual(original)
          await Source.cancel({ binding, store, signal, async verify() {} })
          expect((await Epochs.inspect(binding)).phase).toBe("cancelled")
        } finally {
          if (lease) await Physical.release(lease)
        }
      },
    }),
  )
}, 15000)
