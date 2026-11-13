import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import {
  SessionTransferWorkspaces,
  SessionTransferEpochs as Epochs,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { NativeSessionTransferPhysical as Physical } from "./session-transfer-physical"
import { NativeWorkspacePortableTree } from "./workspace/portable-tree"
import { NativeWorkspacePortableTarget } from "./workspace/portable-target"

export function registerSessionTransferWorkspaces() {
  SessionTransferWorkspaces.registerHost({
    source(value) {
      const binding = Epochs.Binding.parse(value)
      const lease = Physical.sourceCapture(binding)
      const assert = Physical.sourceCaptureVerifier(binding)
      return {
        assert,
        async capture(value, store, signal) {
          const info = WorkspaceCatalog.Info.parse(value)
          if (Physical.sourceCapture(binding) !== lease)
            throw new Error("Workspace capture requires its original native source callback")
          assert()
          signal.throwIfAborted()
          if (info.scopeID !== binding.scopeID || info.backend?.provider === "objects" || info.activeMount)
            throw new Error("Workspace files require their actual native owner")
          if (info.sharedWritableWorkspaceIDs.length)
            throw new Error("Workspace capture requires explicit mappings for additional writable locations")
          const selected = await WorkspaceBinding.validate(info.id, info.scopeID, info.binding.generation)
          assert()
          const root = await fs.realpath(selected.path)
          const home = await fs.realpath(Global.Path.root)
          if (root === home || home.startsWith(root + path.sep))
            throw new Error("Workspace capture overlaps Runtime data")
          const capture = () =>
            Physical.withWorkspaceClaim(info.id, () =>
              WorkspaceAccess.exclusive([root], async () => {
                assert()
                await WorkspaceBinding.validate(info.id, info.scopeID, info.binding.generation)
                const captured = await NativeWorkspacePortableTree.capture({
                  root,
                  directory: path.join(Global.Path.cache, "session-workspace-files"),
                  store,
                  signal,
                })
                await WorkspaceBinding.validate(info.id, info.scopeID, info.binding.generation)
                assert()
                return captured
              }),
            )
          if (root.startsWith(home + path.sep))
            return NativeWorkspacePortableTarget.withPublishedSource(info, signal, capture)
          return capture()
        },
      }
    },
  })
}
