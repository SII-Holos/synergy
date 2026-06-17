import { Filesystem } from "../util/filesystem"
import type { Scope } from "../scope"

export interface WorkspacePolicyData {
  activeRoot: string
  workspaceType: string
  scopeID: string
}

export class WorkspacePolicy {
  readonly activeRoot: string
  readonly workspaceType: string
  readonly scopeID: string

  private constructor(data: WorkspacePolicyData) {
    this.activeRoot = data.activeRoot
    this.workspaceType = data.workspaceType
    this.scopeID = data.scopeID
  }

  static create(data: WorkspacePolicyData): WorkspacePolicy {
    return new WorkspacePolicy(data)
  }

  static async fromSession(
    session: {
      workspace?: import("../session/types").Workspace
      scope?: { directory?: string; id?: string } | Scope
    },
  ): Promise<WorkspacePolicy> {
    const ws: import("../session/types").Workspace | undefined =
      (session as Record<string, unknown>).workspace as typeof ws
    const scope = (session as Record<string, unknown>).scope as
      | { directory?: string; id?: string }
      | undefined

    if (ws) {
      return new WorkspacePolicy({
        activeRoot: ws.path,
        workspaceType: ws.type,
        scopeID: ws.scopeID,
      })
    }

    const scopeDirectory = scope?.directory ?? ""
    const scopeID = scope?.id ?? ""
    return new WorkspacePolicy({
      activeRoot: scopeDirectory,
      workspaceType: "main",
      scopeID,
    })
  }

  static fromDefault(
    scope: { directory: string; id: string },
    workspace?: import("../session/types").Workspace,
  ): WorkspacePolicy {
    if (workspace) {
      return new WorkspacePolicy({
        activeRoot: workspace.path,
        workspaceType: workspace.type,
        scopeID: workspace.scopeID,
      })
    }
    return new WorkspacePolicy({
      activeRoot: scope.directory,
      workspaceType: "main",
      scopeID: scope.id,
    })
  }

  contains(targetPath: string): boolean {
    return Filesystem.contains(this.activeRoot, targetPath)
  }
}
