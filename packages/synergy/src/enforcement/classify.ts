import path from "path"
import { Filesystem } from "../util/filesystem"

export namespace PathClassifier {
  export type Boundary = "inside" | "outside"
  export type Confidence = "high" | "medium" | "low"

  export interface Options {
    workspace: string
    originalCheckout?: string
  }

  export interface Result {
    boundary: Boundary
    confidence: Confidence
    reason: string
  }

  function inside(reason: string): Result {
    return { boundary: "inside", confidence: "high", reason }
  }

  function outside(reason: string): Result {
    return { boundary: "outside", confidence: "high", reason }
  }

  function hasShellExpansion(input: string): boolean {
    return input.startsWith("~") || input.includes("$HOME") || input.includes("${HOME}")
  }

  function normalizeWorkspace(workspace: string): string {
    return path.resolve(workspace)
  }

  function normalizeCandidate(input: string, workspace: string): string {
    if (input === "" || input === ".") return workspace
    if (path.isAbsolute(input)) return path.normalize(input)
    return path.resolve(workspace, input)
  }

  function containsParentTraversal(input: string): boolean {
    const parts = input.split(/[\\/]+/)
    return parts.includes("..")
  }

  export function classify(input: string, options: Options): Result {
    const workspace = normalizeWorkspace(options.workspace)
    if (hasShellExpansion(input)) return outside("path uses shell expansion outside the active workspace")
    if (containsParentTraversal(input)) return outside("path traverses outside the active workspace")

    const candidate = normalizeCandidate(input, workspace)
    if (Filesystem.contains(workspace, candidate)) return inside("path is inside the active workspace")
    return outside("absolute path is outside the active workspace")
  }

  function globBase(pattern: string): string {
    const parts = pattern.split(/[\\/]+/)
    const base: string[] = []
    for (const part of parts) {
      if (!part) {
        if (base.length === 0 && pattern.startsWith(path.sep)) base.push("")
        continue
      }
      if (part.includes("*") || part.includes("?") || part.includes("[") || part.includes("{") || part.includes("}"))
        break
      base.push(part)
    }
    if (pattern.startsWith(path.sep)) return path.sep + base.filter(Boolean).join(path.sep)
    return base.join(path.sep) || "."
  }

  export function classifyGlobPattern(pattern: string, options: Options): Result {
    return classify(globBase(pattern), options)
  }

  export function classifyBatch(inputs: string[], options: Options): Result[] {
    return inputs.map((input) => classify(input, options))
  }

  /**
   * Classify a path with original-checkout awareness for worktree sessions.
   *
   * Pure string analysis — no filesystem I/O. Uses the same prefix-containment
   * logic as classify() but enriches the reason when originalCheckout is provided
   * and the path falls within the original checkout directory.
   */
  export function classifyPath(input: string, options: Options): Result {
    const base = classify(input, options)

    if (!options.originalCheckout) return base

    // If the base classifier already determined the path is inside the active
    // workspace, the originalCheckout check must not override that.  Worktrees
    // reside under the repo root (the original checkout), so without this guard
    // every worktree-internal path would be incorrectly classified as outside.
    if (base.boundary === "inside") return base
    const workspace = normalizeWorkspace(options.workspace)
    const candidate = normalizeCandidate(input, workspace)
    const oc = path.resolve(options.originalCheckout)

    // Check if the candidate falls within the original checkout.
    // This catches paths that are outside the active worktree but inside the
    // original main checkout, and enriches the reason accordingly.
    if (!path.relative(oc, candidate).startsWith("..")) {
      return outside("path is in the original checkout, outside the active workspace")
    }

    // Detect sibling worktrees (same parent directory as workspace, different
    // from original checkout).
    const workspaceParent = path.dirname(workspace)
    const candidateParent = path.dirname(candidate)
    if (
      workspaceParent === candidateParent &&
      workspace !== candidate &&
      !path.relative(oc, workspaceParent).startsWith("..")
    ) {
      return outside("path is in a sibling worktree, outside the active workspace")
    }

    return base
  }
}
