import path from "node:path"
import { normalizeBrowserURL as normalizeBrowserURLInput } from "@ericsanchezok/synergy-browser"

export namespace BrowserPolicy {
  export type Decision = "allow" | "blocked" | "deny"

  export interface PolicyResult {
    decision: Decision
    reason: string
    permanent: boolean
  }

  export const LOCALHOST_ALLOW_PORTS: readonly number[] = [
    ...range(3000, 3010),
    ...range(4000, 4005),
    ...range(5000, 5005),
    ...range(5173, 5183),
    ...range(8000, 8010),
    ...range(8080, 8085),
    ...range(9000, 9005),
    8888,
    80,
    443,
  ]
  export const SENSITIVE_PORTS: readonly number[] = [22, 3306, 5432, 6379, 27017, 9200, 9090, 11434]

  const localhostAllowPorts = new Set(LOCALHOST_ALLOW_PORTS)
  const sensitivePorts = new Set(SENSITIVE_PORTS)
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

  export function hardCheckNavigation(url: string, _workspace: string): PolicyResult {
    const parsed = parseURL(url)
    if (!parsed) return deny(`Invalid URL: ${url}`)
    const protocol = parsed.protocol.slice(0, -1)
    if (protocol === "file") return deny("Browser navigation does not support file:// URLs", true)
    if (protocol === "about") {
      return parsed.href === "about:blank" ? allow("Blank page", true) : deny("Only about:blank is allowed")
    }
    if (protocol !== "http" && protocol !== "https") return deny(`Protocol not allowed: ${protocol}`)
    const port = effectivePort(parsed)
    if (isLocalhost(parsed.hostname) && isSensitivePort(parsed.hostname, port)) {
      return deny(`Port ${port} on ${parsed.hostname} is blocked for security`)
    }
    return allow("User browser navigation")
  }

  export function evaluateURL(url: string, _workspace: string): PolicyResult {
    const parsed = parseURL(url)
    if (!parsed) return deny(`Invalid URL: ${url}`)
    const protocol = parsed.protocol.slice(0, -1)
    if (protocol === "file") return deny("Browser navigation does not support file:// URLs", true)
    if (protocol !== "http" && protocol !== "https") return deny(`Protocol not allowed: ${protocol}`)
    const port = effectivePort(parsed)
    if (isLocalhost(parsed.hostname)) {
      if (isSensitivePort(parsed.hostname, port)) {
        return deny(`Port ${port} on ${parsed.hostname} is blocked for security`)
      }
      if (localhostAllowPorts.has(port)) return allow(`Localhost dev server port ${port}`, true)
      return blocked(`Localhost port ${port} requires user approval`)
    }
    return blocked(`External URL requires user approval: ${parsed.hostname}`)
  }

  export function isSensitivePort(hostname: string, port: number): boolean {
    if (!isLocalhost(hostname)) return false
    return (port < 1024 && port !== 80 && port !== 443) || sensitivePorts.has(port)
  }

  export function isDangerousDownload(input: { mimeType?: string | null; filename?: string | null }): boolean {
    const mimeType = input.mimeType?.split(";", 1)[0]?.trim().toLowerCase()
    if (mimeType && blockedDownloadMimes.has(mimeType)) return true
    const filename = input.filename?.trim().toLowerCase()
    return Boolean(filename && blockedDownloadExtensions.has(path.extname(filename)))
  }
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

function parseURL(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function effectivePort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
}

function allow(reason: string, permanent = false): BrowserPolicy.PolicyResult {
  return { decision: "allow", reason, permanent }
}

function blocked(reason: string): BrowserPolicy.PolicyResult {
  return { decision: "blocked", reason, permanent: false }
}

function deny(reason: string, permanent = false): BrowserPolicy.PolicyResult {
  return { decision: "deny", reason, permanent }
}
