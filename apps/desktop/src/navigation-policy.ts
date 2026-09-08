const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"])

export function isAllowedAppNavigation(url: string, allowedOrigin: string | null): boolean {
  if (url.startsWith("data:text/html")) return true
  if (!allowedOrigin) return false
  try {
    const candidate = new URL(url)
    const allowed = new URL(allowedOrigin)
    return candidate.origin === allowed.origin && LOCALHOST_HOSTS.has(candidate.hostname)
  } catch {
    return false
  }
}

export function canOpenExternal(url: string): boolean {
  try {
    const parsed = new URL(url)
    return EXTERNAL_PROTOCOLS.has(parsed.protocol)
  } catch {
    return false
  }
}
