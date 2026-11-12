import path from "node:path"
import fs from "node:fs/promises"
import { z } from "zod"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { NativeWorkspacePortableTree } from "./portable-tree"
import type { WorkspaceCoordinator } from "./coordinator"

const Reference = z.strictObject({
  workspaceID: z.string(),
  scopeID: z.string(),
  generation: z.number().int().positive(),
  hostID: z.string(),
  physicalID: z.string(),
  path: z.string(),
  claim: z.strictObject({ id: z.string(), token: z.string() }),
})
function inside(root: string, filename: string) {
  const relative = path.relative(root, filename)
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
}

export function registerNativeWorkspaceMove(coordinator: WorkspaceCoordinator) {
  WorkspaceMove.registerSourceHost({
    async preview(source, store, consume, signal) {
      source = { ...source }
      store = { get: store.get.bind(store), put: store.put.bind(store) }
      const assert = WorkspaceContent.captureOwner(signal)
      const initial = await WorkspaceBinding.validate(source.workspaceID, source.scopeID, source.generation)
      assert()
      return WorkspaceAccess.exclusive(
        [initial.path],
        async () => {
          assert()
          const binding = await WorkspaceBinding.validate(source.workspaceID, source.scopeID, source.generation)
          const info = await WorkspaceCatalog.get(source.workspaceID, source.scopeID)
          const runtimeRoot = await fs.realpath(RuntimeContext.current().host.root)
          assert()
          if (
            binding.path !== initial.path ||
            info.backend?.provider !== "directory" ||
            info.activeMount ||
            !info.binding.physicalID ||
            info.sharedWritableWorkspaceIDs.length ||
            inside(runtimeRoot, binding.path) ||
            inside(binding.path, runtimeRoot)
          )
            throw new Error("Workspace preview requires its original supported native directory")
          const root = await NativeWorkspacePortableTree.capture({
            root: binding.path,
            directory: path.join(RuntimeContext.current().host.root, "cache", "workspace-moves"),
            store,
            signal,
          })
          assert()
          const current = await WorkspaceCatalog.get(source.workspaceID, source.scopeID)
          if (JSON.stringify(current) !== JSON.stringify(info))
            throw new Error("Workspace preview target changed during capture")
          let open = true
          const check = () => {
            assert()
            if (!open) throw new Error("Native Workspace preview callback has ended")
          }
          try {
            return await consume(info, root, check)
          } finally {
            open = false
          }
        },
        signal,
      )
    },
    async hold(source, id, previous, signal) {
      source = { ...source }
      const assert = WorkspaceContent.captureOwner(signal)
      const current = await WorkspaceBinding.validate(source.workspaceID, source.scopeID, source.generation)
      const info = await WorkspaceCatalog.get(source.workspaceID, source.scopeID)
      assert()
      if (info.backend?.provider !== "directory" || info.activeMount || !info.binding.physicalID)
        throw new Error("Workspace move source must be its original native directory")
      if (info.sharedWritableWorkspaceIDs.length)
        throw new Error("Workspace move requires explicit mappings for additional writable locations")
      const runtimeRoot = await fs.realpath(RuntimeContext.current().host.root)
      if (inside(runtimeRoot, current.path) || inside(current.path, runtimeRoot))
        throw new Error("Workspace move source overlaps Runtime data")
      assert()
      let retained = previous === undefined ? undefined : Reference.parse(previous)
      if (!retained) {
        const original = (await coordinator.inspect()).find((claim) => claim.id === id)
        if (original) {
          if (!original.durable || original.kind !== "exclusive" || original.state !== "active")
            throw new Error("Workspace move dispatch has another native claim")
          retained = Reference.parse({
            ...source,
            hostID: info.binding.hostID,
            physicalID: info.binding.physicalID,
            path: current.path,
            claim: { id: original.id, token: original.token },
          })
        }
      }
      if (
        retained &&
        (retained.workspaceID !== source.workspaceID ||
          retained.scopeID !== source.scopeID ||
          retained.generation !== source.generation ||
          retained.hostID !== info.binding.hostID ||
          retained.physicalID !== info.binding.physicalID ||
          retained.path !== current.path ||
          retained.claim.id !== id)
      )
        throw new Error("Workspace move native source reference changed")
      if (retained) await coordinator.validateRetention(retained.claim, current.path)
      const lease = retained
        ? await WorkspaceAccess.recoverExclusive(retained.claim)
        : await WorkspaceAccess.hostClaim({
            id,
            kind: "exclusive",
            roots: [current.path],
            durable: true,
            signal,
            timeoutMs: 1000,
          })
      if (!lease.recovery) throw new Error("Workspace move source requires a retained native claim")
      const reference = Reference.parse({
        ...source,
        hostID: info.binding.hostID,
        physicalID: info.binding.physicalID,
        path: current.path,
        claim: lease.recovery,
      })
      return {
        reference,
        capture(store, consume) {
          return WorkspaceAccess.withExclusiveClaim(
            lease,
            async () => {
              const before = await WorkspaceBinding.validate(source.workspaceID, source.scopeID, source.generation)
              const verified = await WorkspaceCatalog.get(source.workspaceID, source.scopeID)
              if (
                before.path !== reference.path ||
                verified.binding.physicalID !== reference.physicalID ||
                verified.binding.hostID !== reference.hostID
              )
                throw new Error("Workspace move source physical identity changed")
              const root = await NativeWorkspacePortableTree.capture({
                root: before.path,
                directory: path.join(RuntimeContext.current().host.root, "cache", "workspace-moves"),
                store,
                signal,
              })
              await WorkspaceBinding.validate(source.workspaceID, source.scopeID, source.generation)
              let open = true
              const check = () => {
                assert()
                if (!open) throw new Error("Workspace move native capture callback has ended")
              }
              try {
                return await consume(info, root, check)
              } finally {
                open = false
              }
            },
            signal,
          )
        },
      }
    },
    async release(source, id, value) {
      const original = value === undefined ? (await coordinator.inspect()).find((claim) => claim.id === id) : undefined
      if (value === undefined && !original) return
      if (original && (!original.durable || original.kind !== "exclusive"))
        throw new Error("Workspace move dispatch has another native claim")
      const reference =
        value === undefined
          ? { ...source, claim: { id: original!.id, token: original!.token } }
          : Reference.parse(value)
      if (
        reference.workspaceID !== source.workspaceID ||
        reference.scopeID !== source.scopeID ||
        reference.generation !== source.generation
      )
        throw new Error("Workspace move release belongs to another native source")
      if (reference.claim.id !== id)
        throw new Error("Workspace move release belongs to another native namespace or request")
      const lease = await coordinator.recover(reference.claim)
      await lease.release()
      if (!(await lease.isReleased())) throw new Error("Workspace move native source release is unresolved")
    },
  })
}
