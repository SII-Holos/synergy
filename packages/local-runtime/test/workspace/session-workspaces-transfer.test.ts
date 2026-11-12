import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
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
    await reopened.run(async () => {
      const workspace = await WorkspaceCatalog.get(publishedWorkspace!, "home")
      expect(await Files.ownsWorkspace(workspace, signal)).toBe(true)
      expect(await Files.ownsWorkspace({ ...workspace, id: "unrelated-workspace" }, signal)).toBe(false)
      expect(
        await Files.ownsWorkspace({ ...workspace, binding: { ...workspace.binding, physicalID: "changed" } }, signal),
      ).toBe(false)
    })
  } finally {
    if (lease) await source.run(() => Physical.release(lease!))
    await target.close()
    await source.close()
  }
})
