import { SessionTransferSchema } from "./transfer-schema"
import { RuntimeContext } from "../lifecycle/context"
import type { WorkspaceCatalog } from "../workspace/catalog"
import type { WorkspaceTree } from "../workspace/tree"
import type { BlobStore } from "../workspace/content"

export namespace SessionTransferWorkspace {
  export const Rejected = SessionTransferSchema.Rejected
  export interface Host {
    capture<T>(
      workspaceID: string,
      store: BlobStore,
      consume: (info: WorkspaceCatalog.Info, tree: WorkspaceTree.Manifest) => Promise<T>,
    ): Promise<T>
    materialize(migrationID: string, tree: WorkspaceTree.Manifest, store: BlobStore): Promise<string>
    validate(migrationID: string): Promise<string>
  }
  const state = RuntimeContext.state(() => ({ host: undefined as Host | undefined }))
  export function register(host: Host) {
    RuntimeContext.assertCompositionOpen("Session transfer Workspace")
    if (state().host) throw new Error("Session transfer Workspace Host is already registered")
    state().host = host
  }
  export function get() {
    const host = state().host
    if (!host) throw new Rejected({ message: "This Runtime cannot transfer a native Workspace" })
    return host
  }
}
