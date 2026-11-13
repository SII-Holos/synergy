import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import {
  SessionTransferCore as Core,
  SessionTransferEpochs as Epochs,
  SessionTransferOwners as Owners,
  SessionTransferSource as Source,
  SessionTransferStaging as Staging,
  SessionTransferStream as Stream,
  SessionTransferWorkspaces as Files,
} from "@ericsanchezok/synergy-harness/session/transfer"
import type { BlobStore } from "@ericsanchezok/synergy-harness/storage/blobs"
import { registerWorkspace } from "../../src/register-workspace"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { NativeSessionTransferPhysical as Physical } from "../../src/session-transfer-physical"
import { NativeWorkspacePortableTarget as Native } from "../../src/workspace/portable-target"

test("complete native file closure and every Session publish together after private target preparation", async () => {
  await using temporary = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(temporary.path, "claims") })
  const targetHome = path.join(temporary.path, "target-home")
  const source = await testRuntime({
    register() {
      registerWorkspace(coordinator)
      Core.register()
      Files.register()
    },
  })
  const target = await testRuntime({
    home: targetHome,
    register() {
      registerWorkspace(coordinator)
      Core.register()
      Files.register()
    },
  })
  const objects = new Map<string, Uint8Array>()
  const store: BlobStore = {
    async put(hash, value) {
      objects.set(hash, value.slice())
    },
    async get(hash, maximum) {
      const value = objects.get(hash)
      if (!value || value.byteLength > maximum) throw new Error("Missing bounded object")
      return value.slice()
    },
  }
  const signal = new AbortController().signal
  const sourceStorage = await source.run(() => Storage.current())
  let lease: Physical.Lease | undefined
  let publishedWorkspace: string | undefined
  try {
    const original = await source.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const directory = path.join(temporary.path, "source-files")
          await fs.mkdir(directory)
          await Bun.write(path.join(directory, "file"), "complete original bytes")
          const workspace = await WorkspaceBinding.register("home", directory)
          const root = await Session.create({ workspaceID: workspace.id, environmentID: null })
          const child = await Session.create({ parentID: root.id, workspaceID: null, environmentID: null })
          const binding = {
            sessionID: root.id,
            scopeID: "home",
            handoffID: "complete-native-files",
            sourceID: "source",
            targetID: "target",
            fromEpoch: 1,
            toEpoch: 2,
          }
          const manifest = await Source.prepare({
            binding,
            signal,
            store,
            async verify() {
              signal.throwIfAborted()
              if (lease) Physical.assertCurrent(lease)
            },
            async beforeFreeze() {
              lease = await Physical.begin({ ...binding, rootSessionID: root.id }, { signal })
              await Physical.withCapture(lease, () => Files.capture({ binding, signal }))
            },
          })
          const receipt = await Files.receipt(binding)
          if (!receipt) throw new Error("Missing source file closure")
          return { root, child, binding, manifest: manifest.root, receipt, directory }
        },
      }),
    )
    await target.run(async () => {
      await Staging.receive({ handoffID: original.binding.handoffID, root: original.manifest, store, signal })
      await expect(
        Files.prepareTarget({ binding: original.binding, expectedReceiptHash: "f".repeat(64), signal }),
      ).rejects.toThrow("frozen closure")
      const prepared = await Files.prepareTarget({
        binding: original.binding,
        expectedReceiptHash: original.receipt.hash,
        signal,
      })
      expect(prepared.sourceReceiptHash).toBe(original.receipt.hash)
      expect((await Storage.queryKeys({ prefix: ["workspace"], limit: 1 })).length).toBe(0)
      await expect(Session.get(original.root.id)).rejects.toThrow()
      const contexts: { ownerID: string; context: Owners.TargetContext }[] = []
      const bindings: Epochs.Binding[] = []
      for await (const member of Staging.members({
        handoffID: original.binding.handoffID,
        rootSessionID: original.root.id,
        scopeID: "home",
        signal,
      })) {
        const binding = {
          ...original.binding,
          sessionID: member.session.id,
          ...(member.session.id === original.root.id ? {} : { rootSessionID: original.root.id }),
        }
        await Epochs.reserve(binding, Stream.digest(original.manifest))
        bindings.push(binding)
        const mapping = await Files.targetMapping({
          handoffID: original.binding.handoffID,
          sessionID: member.session.id,
          signal,
        })
        for (const ownerID of ["session-core", "session-workspaces"]) {
          const context = await Staging.context({
            handoffID: original.binding.handoffID,
            rootSessionID: original.root.id,
            ownerID,
            session: member.session,
            mapping,
            signal,
          })
          await Owners.validate(ownerID, context)
          contexts.push({ ownerID, context })
        }
      }
      await expect(
        Epochs.activateMany({
          bindings,
          manifestHash: Stream.digest(original.manifest),
          signal,
          publish: () => Staging.publish({ handoffID: original.binding.handoffID, contexts }),
        }),
      ).rejects.toThrow("publication")
      await expect(Session.get(original.root.id)).rejects.toThrow()
      await source.run(() =>
        Source.surrender({
          binding: original.binding,
          manifestHash: Stream.digest(original.manifest),
          preparedHash: prepared.hash,
          signal,
          async verify() {
            Physical.assertCurrent(lease!)
          },
        }),
      )
      await source.run(() => Physical.release(lease!))
      lease = undefined
      await source.close()
      await expect(
        Files.withTargetPublication({ handoffID: original.binding.handoffID, signal }, () =>
          Epochs.activateMany({
            bindings,
            manifestHash: Stream.digest(original.manifest),
            signal,
            publish: async () => {
              await Staging.publish({ handoffID: original.binding.handoffID, contexts })
              throw new Error("controlled activation tail failure")
            },
          }),
        ),
      ).rejects.toThrow("activation tail failure")
      await expect(Session.get(original.root.id)).rejects.toThrow()
      expect((await Storage.queryKeys({ prefix: ["workspace"], limit: 1 })).length).toBe(0)
      await Files.withTargetPublication({ handoffID: original.binding.handoffID, signal }, () =>
        Epochs.activateMany({
          bindings,
          manifestHash: Stream.digest(original.manifest),
          signal,
          publish: () => Staging.publish({ handoffID: original.binding.handoffID, contexts }),
        }),
      )
      const root = await Session.get(original.root.id)
      const child = await Session.get(original.child.id)
      expect(child.parentID).toBe(root.id)
      expect(child.workspaceID).toBeNull()
      expect(root.workspaceID).not.toBe(original.root.workspaceID)
      const workspace = await WorkspaceCatalog.get(root.workspaceID!, "home")
      publishedWorkspace = workspace.id
      expect(await Bun.file(path.join(workspace.binding.path!, "file")).text()).toBe("complete original bytes")
      expect((await Epochs.inspect(original.binding)).phase).toBe("activated")
      await expect(
        Files.prepareTarget({ binding: original.binding, expectedReceiptHash: "f".repeat(64), signal }),
      ).rejects.toThrow()
    })
    await target.close()
    await using reopened = await testRuntime({
      home: targetHome,
      register() {
        registerWorkspace(coordinator)
        Core.register()
        Files.register()
      },
    })
    await reopened.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          let workspace = await WorkspaceCatalog.get(publishedWorkspace!, "home")
          expect(await Files.ownsWorkspace(workspace, signal)).toBe(true)
          expect(await Files.ownsWorkspace({ ...workspace, id: "unrelated-workspace" }, signal)).toBe(false)
          expect(
            await Files.ownsWorkspace(
              { ...workspace, binding: { ...workspace.binding, physicalID: "changed" } },
              signal,
            ),
          ).toBe(false)
          const priorRevision = workspace.revision
          workspace = await WorkspaceCatalog.setSharing(workspace.id, {
            scopeID: "home",
            expectedRevision: priorRevision,
            workspaceIDs: [],
          })
          expect(workspace.revision).toBe(priorRevision + 1)
          expect(await Files.ownsWorkspace(workspace, signal)).toBe(true)
          let entered = false
          const capture = async () => {
            entered = true
          }
          const nativeBefore = await Files.withPublishedNative(workspace, signal, async (native) =>
            JSON.stringify(native),
          )
          await expect(
            Storage.provide(sourceStorage, () => Native.withPublishedSource(workspace, signal, capture)),
          ).rejects.toThrow()
          expect(entered).toBe(false)
          expect(await WorkspaceCatalog.get(workspace.id, "home")).toEqual(workspace)
          expect(await Bun.file(path.join(workspace.binding.path!, "file")).text()).toBe("complete original bytes")
          await Files.withPublishedNative(workspace, signal, async (native) => {
            expect(JSON.stringify(native)).toBe(nativeBefore)
            await Native.validate(Native.Receipt.parse(native.receipt), signal)
          })
          await expect(
            Native.withPublishedSource({ ...workspace, scopeID: "another-scope" }, signal, capture),
          ).rejects.toThrow()
          const root = workspace.binding.path!
          const retainedRoot = root + ".retained-original"
          const originalBytes = await Bun.file(path.join(root, "file")).text()
          await fs.rename(root, retainedRoot)
          await fs.mkdir(root)
          await Bun.write(path.join(root, "file"), originalBytes)
          try {
            await expect(Native.withPublishedSource(workspace, signal, capture)).rejects.toThrow("identity changed")
          } finally {
            await fs.rm(root, { recursive: true })
            await fs.rename(retainedRoot, root)
          }
          expect(entered).toBe(false)
          for (const directory of [Global.Path.root, path.dirname(Global.Path.root)]) {
            const ordinary = await WorkspaceBinding.register("home", directory)
            const unrelated = await Session.create({ workspaceID: ordinary.id, environmentID: null })
            const rejected = {
              sessionID: unrelated.id,
              scopeID: "home",
              handoffID: "home-root-rejected-" + unrelated.id,
              sourceID: "target",
              targetID: "source",
              fromEpoch: 1,
              toEpoch: 2,
            }
            let deniedLease: Physical.Lease | undefined
            try {
              await expect(
                Source.prepare({
                  binding: rejected,
                  signal,
                  store,
                  async verify() {
                    signal.throwIfAborted()
                    if (deniedLease) Physical.assertCurrent(deniedLease)
                  },
                  async beforeFreeze() {
                    deniedLease = await Physical.begin({ ...rejected, rootSessionID: unrelated.id }, { signal })
                    await Physical.withCapture(deniedLease, () => Files.capture({ binding: rejected, signal }))
                  },
                }),
              ).rejects.toThrow("overlaps Runtime data")
            } finally {
              if (deniedLease) await Physical.release(deniedLease)
            }
          }
          const ordinaryDirectory = path.join(Global.Path.root, "ordinary-home-subtree")
          await fs.mkdir(ordinaryDirectory)
          const ordinary = await WorkspaceBinding.register("home", ordinaryDirectory)
          await expect(Native.withPublishedSource(ordinary, signal, capture)).rejects.toThrow("activated publication")
          expect(entered).toBe(false)
          const received = await Session.get(original.root.id)
          const currentBytes = "current bytes edited after the first native publication"
          const untrackedBytes = "new untracked bytes after publication"
          await Bun.write(path.join(workspace.binding.path!, "file"), currentBytes)
          await Bun.write(path.join(workspace.binding.path!, "untracked"), untrackedBytes)
          const next = {
            sessionID: received.id,
            scopeID: received.scope.id,
            handoffID: "received-native-next-source",
            sourceID: original.binding.targetID,
            targetID: original.binding.sourceID,
            fromEpoch: original.binding.toEpoch,
            toEpoch: original.binding.toEpoch + 1,
          }
          let nextLease: Physical.Lease | undefined
          try {
            const captured = await Source.prepare({
              binding: next,
              signal,
              store,
              async verify() {
                signal.throwIfAborted()
                if (nextLease) Physical.assertCurrent(nextLease)
              },
              async beforeFreeze() {
                nextLease = await Physical.begin({ ...next, rootSessionID: received.id }, { signal })
                await Physical.withCapture(nextLease, async () => {
                  const files = await Files.capture({ binding: next, signal })
                  expect(files).toMatchObject({
                    workspaces: 1,
                    entries: 2,
                    bytes: Buffer.byteLength(currentBytes) + Buffer.byteLength(untrackedBytes),
                  })
                })
              },
            })
            expect(captured.root.complete).toBe(true)
            const receipt = await Files.receipt(next)
            expect(receipt).toMatchObject({ members: 2, workspaces: 1 })
            expect(receipt?.hash).toMatch(/^[a-f0-9]{64}$/)
            expect(await Bun.file(path.join(workspace.binding.path!, "file")).text()).toBe(currentBytes)
            expect(await Bun.file(path.join(workspace.binding.path!, "untracked")).text()).toBe(untrackedBytes)
            await Source.cancel({
              binding: next,
              signal,
              store,
              async verify() {
                Physical.assertCurrent(nextLease!)
              },
            })
            expect((await Epochs.inspect(next)).phase).toBe("cancelled")
          } finally {
            if (nextLease) await Physical.release(nextLease)
          }
          const rebound = await WorkspaceBinding.rebind(
            workspace.id,
            {
              scopeID: "home",
              expectedRevision: workspace.revision,
              path: workspace.binding.path!,
            },
            signal,
          )
          expect(rebound.binding.generation).toBe(workspace.binding.generation + 1)
          expect(await Files.ownsWorkspace(rebound, signal)).toBe(false)
          await expect(Native.withPublishedSource(rebound, signal, capture)).rejects.toThrow("activated publication")
          expect(entered).toBe(false)
        },
      }),
    )
  } finally {
    if (lease) await source.run(() => Physical.release(lease!))
    await target.close()
    await source.close()
  }
})
