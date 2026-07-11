import { realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { normalizeBrowserURL as normalizeBrowserURLInput } from "@ericsanchezok/synergy-browser"
import { isPathContained } from "../util/path-contain.js"

export namespace BrowserPolicy {
  export type Decision = "allow" | "deny"

  export interface PolicyResult {
    decision: Decision
    reason: string
    permanent: boolean
  }

  const blockedWorkspaceSegments = new Set(["node_modules", ".git", ".synergy"])
  const blockedDownloadMimes = new Set(["application/x-msdownload", "application/x-sh", "application/x-mach-binary"])
  const blockedDownloadExtensions = new Set([
    ".app",
    ".bat",
    ".cmd",
    ".com",
    ".dmg",
    ".exe",
    ".msi",
    ".pkg",
    ".ps1",
    ".scr",
    ".sh",
    ".vbs",
  ])

  export const normalizeBrowserURL = normalizeBrowserURLInput

  export function hardCheckNavigation(url: string, workspace: string): PolicyResult {
    const parsed = parseURL(url)
    if (!parsed) return deny(`Invalid URL: ${url}`)
    if (parsed.protocol === "file:") return evaluateFileURL(parsed, workspace)
    if (parsed.protocol === "about:") {
      return parsed.href === "about:blank" ? allow("Blank page", true) : deny("Only about:blank is allowed")
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return deny(`Protocol not allowed: ${parsed.protocol.slice(0, -1)}`)
    }
    return allow("Browser navigation")
  }

  export function isDangerousDownload(input: { mimeType?: string | null; filename?: string | null }): boolean {
    const mimeType = input.mimeType?.split(";", 1)[0]?.trim().toLowerCase()
    if (mimeType && blockedDownloadMimes.has(mimeType)) return true
    const filename = input.filename?.trim().toLowerCase()
    return Boolean(filename && blockedDownloadExtensions.has(path.extname(filename)))
  }

  function evaluateFileURL(url: URL, workspace: string): PolicyResult {
    let requestedPath: string
    try {
      requestedPath = path.resolve(fileURLToPath(url))
    } catch {
      return deny(`Invalid file URL: ${url.href}`)
    }

    let root: string
    try {
      root = realpathSync(workspace)
    } catch {
      return deny(`Workspace path does not exist or cannot be resolved: ${workspace}`)
    }
    const requestedBlocked = blockedSegment(root, requestedPath)
    if (requestedBlocked) return deny(`Path contains a blocked segment: ${requestedBlocked}`)

    let filePath: string
    try {
      filePath = realpathSync(requestedPath)
    } catch {
      return deny(`File path does not exist or cannot be resolved: ${requestedPath}`)
    }
    if (!isPathContained(root, filePath)) return deny(`File path is outside the workspace: ${filePath}`)

    const resolvedBlocked = blockedSegment(root, filePath)
    if (resolvedBlocked) return deny(`Path contains a blocked segment: ${resolvedBlocked}`)
    return allow("File path is within workspace", true)
  }

  function blockedSegment(root: string, target: string): string | undefined {
    if (!isPathContained(root, target)) return
    return path
      .relative(root, target)
      .split(path.sep)
      .filter(Boolean)
      .find((segment) => segment.startsWith(".") || blockedWorkspaceSegments.has(segment))
  }
}

function parseURL(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function allow(reason: string, permanent = false): BrowserPolicy.PolicyResult {
  return { decision: "allow", reason, permanent }
}

function deny(reason: string): BrowserPolicy.PolicyResult {
  return { decision: "deny", reason, permanent: false }
}
