import { realpathSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { normalizeBrowserURL as normalizeBrowserURLInput } from "@ericsanchezok/synergy-util/browser-protocol"
import { isPathContained } from "../util/path-contain"

export namespace BrowserPolicy {
  export type Decision = "allow" | "blocked" | "deny"

  export interface PolicyResult {
    decision: Decision
    reason: string
    permanent: boolean
  }

  // ── Constants ──────────────────────────────────────────────────────

  export const LOCALHOST_ALLOW_PORTS: readonly number[] = [
    // Dev server ranges
    ...range(3000, 3010),
    ...range(4000, 4005),
    ...range(5000, 5005),
    ...range(5173, 5183),
    ...range(8000, 8010),
    ...range(8080, 8085),
    ...range(9000, 9005),
    // Singletons
    8888,
    // Standard HTTP(S)
    80,
    443,
  ] as const

  export const SENSITIVE_PORTS: readonly number[] = [22, 3306, 5432, 6379, 27017, 9200, 9090, 11434] as const

  export const ALLOWED_DOWNLOAD_MIMES: readonly string[] = [
    "text/*",
    "image/*",
    "application/json",
    "application/pdf",
    "application/zip",
    "application/gzip",
    "application/x-tar",
  ] as const

  // ── Helpers ────────────────────────────────────────────────────────

  const localhostAllowPorts = new Set(LOCALHOST_ALLOW_PORTS)
  const sensitivePorts = new Set(SENSITIVE_PORTS)

  const BLOCKED_FILE_PATH_SEGMENTS = new Set(["node_modules", ".git", ".synergy"])

  const SENSITIVE_HEADERS = new Set(["cookie", "set-cookie", "authorization", "x-api-key", "www-authenticate"])

  const BLOCKED_DOWNLOAD_MIMES = new Set([
    "application/octet-stream",
    "application/x-msdownload",
    "application/x-sh",
    "application/x-mach-binary",
  ])

  const BLOCKED_DOWNLOAD_EXTENSIONS = new Set([
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

  function range(start: number, end: number): number[] {
    const result: number[] = []
    for (let i = start; i <= end; i++) result.push(i)
    return result
  }

  function isLocalhost(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  }

  function isDotfile(filePath: string): boolean {
    const basename = path.basename(filePath)
    return basename.startsWith(".")
  }

  function containsBlockedWorkspaceSegment(filePath: string, workspace: string): boolean {
    const resolved = realpathSync(filePath)
    const resolvedWorkspace = realpathSync(workspace)
    if (!isPathContained(resolvedWorkspace, resolved)) return false

    const relativePath = path.relative(resolvedWorkspace, resolved)
    const segments = relativePath.split(path.sep).filter(Boolean)
    return segments.some((segment) => BLOCKED_FILE_PATH_SEGMENTS.has(segment))
  }

  function isContainedWithin(filePath: string, workspace: string): boolean {
    const resolved = realpathSync(filePath)
    const resolvedWorkspace = realpathSync(workspace)
    return isPathContained(resolvedWorkspace, resolved)
  }

  function evaluateParsedFileURL(url: URL, workspace: string): PolicyResult {
    try {
      return evaluateFileURL(fileURLToPath(url), workspace)
    } catch {
      return {
        decision: "deny",
        reason: `Invalid file URL: ${url.href}`,
        permanent: false,
      }
    }
  }

  function matchMimePattern(mimeType: string, pattern: string): boolean {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1) // e.g. "text/"
      return mimeType.startsWith(prefix)
    }
    return mimeType === pattern
  }

  // ── Public API ─────────────────────────────────────────────────────

  export const normalizeBrowserURL = normalizeBrowserURLInput

  /**
   * User-facing hard safety check. Public http(s) browsing is allowed here;
   * agent approval is layered separately through evaluateURL/control profile.
   */
  export function hardCheckNavigation(url: string, workspace: string): PolicyResult {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { decision: "deny", reason: `Invalid URL: ${url}`, permanent: false }
    }

    const protocol = parsed.protocol.replace(/:$/, "")
    if (protocol === "file") return evaluateParsedFileURL(parsed, workspace)

    if (protocol !== "http" && protocol !== "https" && protocol !== "about") {
      return {
        decision: "deny",
        reason: `Protocol not allowed: ${protocol}`,
        permanent: false,
      }
    }

    if (protocol === "about") {
      if (parsed.href === "about:blank") return { decision: "allow", reason: "Blank page", permanent: true }
      return {
        decision: "deny",
        reason: `Only about:blank is allowed`,
        permanent: false,
      }
    }

    const hostname = parsed.hostname.toLowerCase()
    const port = parsed.port ? parseInt(parsed.port, 10) : protocol === "https" ? 443 : 80
    if (isLocalhost(hostname) && isSensitivePort(hostname, port)) {
      return {
        decision: "deny",
        reason: `Port ${port} on ${hostname} is blocked for security`,
        permanent: false,
      }
    }

    return {
      decision: "allow",
      reason: "User browser navigation",
      permanent: false,
    }
  }

  /**
   * Evaluate a URL against the browser policy. Pure function, no I/O.
   * This keeps agent/automation approval semantics: public URLs and uncommon
   * localhost ports are "blocked" so the tool layer can ask.
   */
  export function evaluateURL(url: string, workspace: string): PolicyResult {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { decision: "deny", reason: `Invalid URL: ${url}`, permanent: false }
    }

    const protocol = parsed.protocol.replace(/:$/, "")

    if (protocol === "file") {
      return evaluateParsedFileURL(parsed, workspace)
    }

    if (protocol !== "http" && protocol !== "https") {
      return {
        decision: "deny",
        reason: `Protocol not allowed: ${protocol}`,
        permanent: false,
      }
    }

    const hostname = parsed.hostname.toLowerCase()
    const port = parsed.port ? parseInt(parsed.port, 10) : protocol === "https" ? 443 : 80

    if (isLocalhost(hostname)) {
      if (isSensitivePort(hostname, port)) {
        return {
          decision: "deny",
          reason: `Port ${port} on ${hostname} is blocked for security`,
          permanent: false,
        }
      }

      if (localhostAllowPorts.has(port)) {
        return {
          decision: "allow",
          reason: `Localhost dev server port ${port}`,
          permanent: true,
        }
      }

      return {
        decision: "blocked",
        reason: `Localhost port ${port} requires user approval`,
        permanent: false,
      }
    }

    // Public URLs — blocked on first visit
    return {
      decision: "blocked",
      reason: `External URL requires user approval: ${parsed.hostname}`,
      permanent: false,
    }
  }

  /**
   * Check file:// containment. Uses realpath via Bun/Node for symlink resolution.
   */
  export function evaluateFileURL(filePath: string, workspace: string): PolicyResult {
    if (containsBlockedWorkspaceSegment(filePath, workspace)) {
      return {
        decision: "deny",
        reason: `Path contains a blocked segment: ${filePath}`,
        permanent: false,
      }
    }

    if (isDotfile(filePath)) {
      return {
        decision: "deny",
        reason: `Dotfiles are blocked: ${filePath}`,
        permanent: false,
      }
    }

    try {
      if (isContainedWithin(filePath, workspace)) {
        return {
          decision: "allow",
          reason: `File path is within workspace`,
          permanent: true,
        }
      }
    } catch {
      return {
        decision: "deny",
        reason: `File path does not exist or cannot be resolved: ${filePath}`,
        permanent: false,
      }
    }

    return {
      decision: "deny",
      reason: `File path is outside the workspace: ${filePath}`,
      permanent: false,
    }
  }

  /**
   * Check if a port+hostname combo is in the deny list.
   */
  export function isSensitivePort(hostname: string, port: number): boolean {
    if (!isLocalhost(hostname)) return false

    if (port < 1024 && port !== 80 && port !== 443) return true

    return sensitivePorts.has(port)
  }

  /**
   * Check if a download MIME type is in the allowlist.
   * Wildcards like "text/*" and "image/*" are supported.
   */
  export function isDownloadAllowed(mimeType: string): boolean {
    const normalized = mimeType.toLowerCase()

    // Explicit blocklist takes precedence
    if (BLOCKED_DOWNLOAD_MIMES.has(normalized)) return false

    for (const pattern of ALLOWED_DOWNLOAD_MIMES) {
      if (matchMimePattern(normalized, pattern)) return true
    }

    return false
  }

  export function isDangerousDownload(input: { mimeType?: string | null; filename?: string | null }): boolean {
    const mimeType = input.mimeType?.split(";")[0]?.trim().toLowerCase()
    if (mimeType && BLOCKED_DOWNLOAD_MIMES.has(mimeType)) return true

    const filename = input.filename?.trim().toLowerCase()
    if (!filename) return false
    const ext = path.extname(filename)
    return BLOCKED_DOWNLOAD_EXTENSIONS.has(ext)
  }

  /**
   * Strip sensitive headers (Cookie, Authorization, etc.) from network data.
   */
  export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
      if (!SENSITIVE_HEADERS.has(key.toLowerCase())) {
        sanitized[key] = value
      }
    }
    return sanitized
  }

  /**
   * Truncate and strip sensitive content from the response body.
   */
  export function sanitizeResponseBody(body: string, maxBytes: number): string {
    const encoded = new TextEncoder().encode(body)
    if (encoded.byteLength <= maxBytes) return body

    // Truncate to maxBytes, ensuring we don't split a multi-byte character
    let truncated = new TextDecoder().decode(encoded.slice(0, maxBytes))

    // Remove any trailing incomplete multi-byte sequence
    const reencoded = new TextEncoder().encode(truncated)
    if (reencoded.byteLength > maxBytes) {
      truncated = new TextDecoder().decode(reencoded.slice(0, maxBytes))
    }

    return truncated + " ... [truncated]"
  }
}
