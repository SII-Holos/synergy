import path from "path"
import { Filesystem } from "../util/filesystem"
/**
 * Paths that are ALWAYS protected regardless of permission profile/mode.
 * Touching these triggers an ask even in full_access mode. This is a hard
 * security boundary that cannot be overridden by profile, Smart allow, or
 * session-level memory.
 */
export const PROTECTED_WRITE_PATHS = [
  ".git/",
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".vscode/",
  ".idea/",
  ".claude/",
  ".synergy/",
  ".husky/",
  ".devcontainer/",
]

export const PROTECTED_READ_PATHS = [".ssh/", ".aws/", ".config/git/", ".gnupg/"]

export const PROTECTED_FILE_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)id_ed25519/i,
  /(^|\/)credentials$/i,
]

export interface ProtectedMatch {
  matched: boolean
  reason?: string
  category?: "vcs" | "config" | "credentials" | "secrets"
}

export function checkProtectedPath(path: string, mode: "read" | "write"): ProtectedMatch {
  if (!path) return { matched: false }
  const normalized = path.replace(/^~\//, "").replace(/^\.\//, "")
  const lower = normalized.toLowerCase()

  for (const pattern of PROTECTED_FILE_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        matched: true,
        reason: `Path matches protected pattern (credentials/secrets)`,
        category: lower.includes(".env") ? "secrets" : "credentials",
      }
    }
  }

  if (mode === "read") {
    for (const prefix of PROTECTED_READ_PATHS) {
      if (lower.startsWith(prefix) || lower.includes("/" + prefix)) {
        return {
          matched: true,
          reason: `Reading from protected directory (${prefix})`,
          category: "credentials",
        }
      }
    }
  }

  if (mode === "write") {
    for (const prefix of PROTECTED_WRITE_PATHS) {
      const trimmed = prefix.endsWith("/") ? prefix : prefix + "/"
      if (lower === prefix || lower.startsWith(trimmed) || lower.includes("/" + trimmed)) {
        // .synergy/worktrees/ is a workspace, not Synergy config data.
        // Paths inside worktrees should not trigger the .synergy/ protected
        // write check. Must handle both relative (startsWith) and absolute
        // (includes "/.synergy/worktrees/") paths.
        if (
          prefix === ".synergy/" &&
          (lower.startsWith(".synergy/worktrees/") || lower.includes("/.synergy/worktrees/"))
        )
          continue
        const category: ProtectedMatch["category"] = prefix.startsWith(".git")
          ? "vcs"
          : prefix.startsWith(".env")
            ? "secrets"
            : "config"
        return {
          matched: true,
          reason: `Writing to protected path (${prefix})`,
          category,
        }
      }
    }
  }

  return { matched: false }
}

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
