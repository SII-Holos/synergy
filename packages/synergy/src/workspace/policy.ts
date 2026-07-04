import path from "path"
import { realpathSync, lstatSync, readlinkSync } from "fs"
import { Filesystem } from "../util/filesystem"
import type { Scope } from "../scope"
import { isPathContained } from "../util/path-contain"

export interface WorkspacePolicyData {
  activeRoot: string
  workspaceType: string
  scopeID: string
  originalCheckout?: string
}

export interface ClassifyResult {
  boundary: "inside" | "outside"
  confidence: "high" | "medium" | "low"
  reason: string
}

export class WorkspacePolicy {
  readonly activeRoot: string
  readonly workspaceType: string
  readonly scopeID: string
  readonly originalCheckout?: string

  private constructor(data: WorkspacePolicyData) {
    this.activeRoot = data.activeRoot
    this.workspaceType = data.workspaceType
    this.scopeID = data.scopeID
    this.originalCheckout = data.originalCheckout
  }

  static create(data: WorkspacePolicyData): WorkspacePolicy {
    return new WorkspacePolicy(data)
  }

  static fromSession(session: {
    workspace?: import("../session/types").Workspace
    scope?: { directory?: string; id?: string } | Scope
  }): WorkspacePolicy {
    const ws = session.workspace
    const scope = session.scope
    if (ws) {
      return new WorkspacePolicy({
        activeRoot: ws.path,
        workspaceType: ws.type,
        scopeID: ws.scopeID,
        originalCheckout: (ws as any).originalCheckout,
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
        originalCheckout: (workspace as any).originalCheckout,
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

  /**
   * Classify a target path relative to the active workspace boundary.
   *
   * Uses realpath to detect symlinks that escape the workspace
   * (e.g. a symlink inside the worktree pointing back to the original checkout).
   */
  classifyPath(targetPath: string): ClassifyResult {
    const activeRoot = path.resolve(this.activeRoot)
    const candidate = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(activeRoot, targetPath)

    let resolved = candidate

    // Detect symlinks via lstat (works even when realpath would fail on a dangling target)
    let isSymlink = false
    try {
      isSymlink = lstatSync(candidate).isSymbolicLink()
    } catch {
      // path does not exist at all
    }

    try {
      resolved = realpathSync(candidate)
    } catch {
      if (isSymlink) {
        // Symlink exists but target does not — resolve target path manually
        const linkTarget = readlinkSync(candidate)
        resolved = path.isAbsolute(linkTarget)
          ? path.resolve(linkTarget)
          : path.resolve(path.dirname(candidate), linkTarget)
      } else {
        // Path does not exist — walk up to nearest existing parent
        let dir = path.dirname(candidate)
        while (dir !== path.dirname(dir) && dir !== "/" && dir !== ".") {
          try {
            const realDir = realpathSync(dir)
            const relative = path.relative(dir, candidate)
            resolved = path.join(realDir, relative)
            break
          } catch {
            dir = path.dirname(dir)
          }
        }
      }
    }

    const insideActive = isPathContained(activeRoot, resolved)

    if (insideActive) {
      return { boundary: "inside", confidence: "high", reason: "path is inside the active workspace" }
    }

    if (this.originalCheckout) {
      const oc = path.resolve(this.originalCheckout)
      if (isPathContained(oc, resolved)) {
        return {
          boundary: "outside",
          confidence: "high",
          reason: isSymlink
            ? "symlink resolves to original checkout outside the active workspace"
            : "path is in the original checkout, outside the active workspace",
        }
      }
    }

    return { boundary: "outside", confidence: "high", reason: "path is outside the active workspace" }
  }
}
