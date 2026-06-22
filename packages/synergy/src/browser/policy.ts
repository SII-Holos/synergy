import { realpathSync } from "fs"
import path from "path"

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

  function containsBlockedFilePathSegment(filePath: string): boolean {
    const segments = filePath.split(path.sep)
    return segments.some((s) => BLOCKED_FILE_PATH_SEGMENTS.has(s))
  }

  function isContainedWithin(filePath: string, workspace: string): boolean {
    const resolved = realpathSync(filePath)
    const resolvedWorkspace = realpathSync(workspace)
    return !path.relative(resolvedWorkspace, resolved).startsWith("..")
  }

  function matchMimePattern(mimeType: string, pattern: string): boolean {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1) // e.g. "text/"
      return mimeType.startsWith(prefix)
    }
    return mimeType === pattern
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Evaluate a URL against the browser policy. Pure function, no I/O.
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
      return evaluateFileURL(parsed.pathname, workspace)
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
    if (containsBlockedFilePathSegment(filePath)) {
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
