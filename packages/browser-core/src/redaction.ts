const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization", "x-api-key"])

export function redactBrowserHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers)
      .slice(0, 200)
      .map(([name, value]) => [
        name.slice(0, 1_000),
        SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[redacted]" : String(value ?? "").slice(0, 20_000),
      ]),
  )
}

export function redactBrowserURL(value: string): string {
  try {
    const url = new URL(value)
    if (url.username) url.username = "[redacted]"
    if (url.password) url.password = "[redacted]"
    for (const key of Array.from(url.searchParams.keys())) {
      if (/token|secret|key|auth|signature|credential|password/i.test(key)) url.searchParams.set(key, "[redacted]")
    }
    if (/token|secret|key|auth|signature|credential|password/i.test(url.hash)) url.hash = "#[redacted]"
    return url.toString()
  } catch {
    return redactBrowserText(value)
  }
}

export function redactBrowserText(value: string): string {
  return value
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+=*/gi, "$1[redacted]")
    .replace(/("?(?:token|secret|password|authorization|api[_-]?key)"?\s*[:=]\s*)"?[^"&,\s}]+"?/gi, '$1"[redacted]"')
}
