import path from "node:path"
import fs from "node:fs/promises"
import { z } from "zod"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding, WorkspaceCatalog, WorkspaceLocation } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
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
const LegacyReference = Reference.pick({ workspaceID: true, scopeID: true, generation: true, claim: true })
function retainedReference(value: unknown, legacy: boolean) {
  return legacy ? z.union([Reference, LegacyReference]).parse(value) : Reference.parse(value)
}
function inside(root: string, filename: string) {
  const relative = path.relative(root, filename)
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
}
function nativeOwner(signal?: AbortSignal) {
  const assert = WorkspaceContent.captureOwner(signal),
    runtime = RuntimeContext.current(),
    primary = runtime.storage
  const location = runtime.host.workspaceLocation,
    identify = location?.identify,
    hostID = location?.hostID
  return () => {
    assert()
    const current = Storage.current()
    if (
      !primary ||
      current.store !== primary.store ||
      current.store.options.readonly ||
      current.artifactDirectory !== primary.artifactDirectory ||
      current.artifactObjects !== primary.artifactObjects ||
      runtime.host.workspaceLocation !== location ||
      location?.identify !== identify ||
      location?.hostID !== hostID
    )
      throw new Error("Native Workspace claims require their actual writable primary Store")
  }
}

export function registerNativeWorkspaceMove(coordinator: WorkspaceCoordinator) {
  WorkspaceMove.registerSourceHost({
    async preview(source, store, consume, signal) {
      source = { ...source }
      store = { get: store.get.bind(store), put: store.put.bind(store) }
      const assert = nativeOwner(signal)
      assert()
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
    async hold(source, id, previous, signal, compatibleIDs) {
      source = { ...source }
      const admissible = new Set([id, ...(compatibleIDs ?? [])])
      let retained = previous === undefined ? undefined : retainedReference(previous, !!compatibleIDs?.length)
      const assert = nativeOwner(signal)
      assert()
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
      const matches = (await coordinator.inspect()).filter((claim) => admissible.has(claim.id))
      assert()
      if (matches.length > 1) throw new Error("Workspace move has multiple retained native dispatch identities")
      if (!retained) {
        const original = matches[0]
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
      const completeRetained = Reference.safeParse(retained)
      if (
        retained &&
        (retained.workspaceID !== source.workspaceID ||
          retained.scopeID !== source.scopeID ||
          retained.generation !== source.generation ||
          (completeRetained.success &&
            (completeRetained.data.hostID !== info.binding.hostID ||
              completeRetained.data.physicalID !== info.binding.physicalID ||
              completeRetained.data.path !== current.path)) ||
          !admissible.has(retained.claim.id))
      )
        throw new Error("Workspace move native source reference changed")
      if (
        retained &&
        !completeRetained.success &&
        (matches[0]?.roots?.length !== 1 || matches[0].roots[0]?.path !== current.path)
      )
        throw new Error("Legacy Workspace capture has no original retained physical root")
      if (retained) await coordinator.validateRetention(retained.claim, current.path)
      assert()
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
      if (lease.recovery.id !== (retained?.claim.id ?? id))
        throw new Error("Workspace move native dispatch changed its original identity")
      const reference = Reference.parse({
        ...source,
        hostID: info.binding.hostID,
        physicalID: info.binding.physicalID,
        path: current.path,
        claim: lease.recovery,
      })
      return {
        reference: retained && !completeRetained.success ? retained : reference,
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
    async release(source, id, value, compatibleIDs) {
      source = { ...source }
      let reference = value === undefined ? undefined : retainedReference(value, !!compatibleIDs?.length)
      const admissible = new Set([id, ...(compatibleIDs ?? [])])
      const assert = nativeOwner()
      assert()
      const matches = (await coordinator.inspect()).filter((claim) => admissible.has(claim.id))
      assert()
      if (matches.length > 1) throw new Error("Workspace move has multiple retained native dispatch identities")
      const original = matches[0]
      if (!reference && !original) return
      if (original && (!original.durable || original.kind !== "exclusive"))
        throw new Error("Workspace move dispatch has another native claim")
      if (!reference) {
        reference = LegacyReference.parse({ ...source, claim: { id: original!.id, token: original!.token } })
      }
      if (
        reference.workspaceID !== source.workspaceID ||
        reference.scopeID !== source.scopeID ||
        reference.generation !== source.generation
      )
        throw new Error("Workspace move release belongs to another native source")
      if (!admissible.has(reference.claim.id))
        throw new Error("Workspace move release belongs to another native namespace or request")
      if (original && original.token !== reference.claim.token)
        throw new Error("Workspace move native dispatch has another retained token")
      const complete = Reference.safeParse(reference)
      if (original && (!original.roots || original.roots.length !== 1))
        throw new Error("Original Workspace dispatch has no bounded physical root")
      if (complete.success) {
        const expected = complete.data
        const locations = WorkspaceLocation.source(),
          hostID = locations.hostID.bind(locations)
        const host = await hostID()
        assert()
        const root = original?.roots?.[0]
        // Catalog identities may include a volume UUID; coordinator roots retain their admission-time identities.
        if (
          host !== expected.hostID ||
          (original &&
            (!root ||
              root.path !== (process.platform === "win32" ? expected.path.toLowerCase() : expected.path) ||
              !root.physicalID))
        )
          throw new Error("Workspace move release changed its original native physical identity")
      }
      const lease = await coordinator.recover(reference.claim)
      await lease.release()
      if (!(await lease.isReleased())) throw new Error("Workspace move native source release is unresolved")
      assert()
    },
  })
}
