import { WorkspacePortableSource } from "./workspace-portable-source"
import { WorkspacePortableTarget } from "./workspace-portable-target"
import { SessionTransferOwners as Owners } from "./transfer-owners"

export namespace SessionTransferWorkspaces {
  export type SourcePort = WorkspacePortableSource.SourcePort
  export type Host = WorkspacePortableSource.Host
  export const registerHost = WorkspacePortableSource.registerHost
  export const registerSourceProvider = WorkspacePortableSource.registerProvider
  export const hasSourceProvider = WorkspacePortableSource.hasProvider
  export const capture = WorkspacePortableSource.capture
  export const receipt = WorkspacePortableSource.receipt
  export const withCaptured = WorkspacePortableSource.withCaptured
  export const registerTargetHost = WorkspacePortableTarget.registerHost
  export const registerTargetProvider = WorkspacePortableTarget.registerProvider
  export const withTargetProvider = WorkspacePortableTarget.withProvider
  export const prepareTarget = WorkspacePortableTarget.prepare
  export const withTargetCaptured = WorkspacePortableTarget.withCaptured
  export const targetMapping = WorkspacePortableTarget.mapping
  export const withTargetPublication = WorkspacePortableTarget.withPublication
  export const ownsWorkspace = WorkspacePortableTarget.ownsWorkspace
  export function register() {
    if (typeof Owners.publicationOrder !== "function")
      throw new Error("Workspace portability requires native publication ordering")
    Owners.register("session-workspaces", {
      version: 1,
      reads: [1],
      stagedDependencies: ["session-core"],
      publicationBefore: ["session-core"],
      applies: WorkspacePortableSource.applies,
      inspect: WorkspacePortableSource.inspect,
      freeze: WorkspacePortableSource.freeze,
      export: WorkspacePortableSource.exportEntries,
      validate: WorkspacePortableTarget.validate,
      publish: WorkspacePortableTarget.publish,
    })
  }
}
