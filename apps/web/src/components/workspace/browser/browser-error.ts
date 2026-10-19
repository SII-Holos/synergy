import { BrowserAPIErrorSchema, redactBrowserText } from "@ericsanchezok/synergy-browser-core"

export interface BrowserErrorInfo {
  message: string
  code?: string
  retryable: boolean
}

export function normalizeBrowserError(error: unknown, fallback: string): BrowserErrorInfo {
  for (const candidate of errorCandidates(error)) {
    const parsed = BrowserAPIErrorSchema.safeParse(candidate)
    if (parsed.success) {
      return { message: parsed.data.message, code: parsed.data.code, retryable: parsed.data.retryable }
    }
  }
  if (error instanceof Error && error.message) return { message: error.message, retryable: false }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return { message: error.message, retryable: false }
  }
  return { message: fallback, retryable: false }
}

export function toBrowserError(error: unknown, fallback: string): Error & BrowserErrorInfo {
  const info = normalizeBrowserError(error, fallback)
  return Object.assign(new Error(info.message), info)
}

function errorCandidates(error: unknown): unknown[] {
  if (!error || typeof error !== "object") return [error]
  const record = error as Record<string, unknown>
  return [error, record.error, record.body, record.data]
}

export function browserErrorPresentation(error: { code?: string; message: string }) {
  const code = error.code ?? ""
  const message = error.message
  const descriptor = (() => {
    if (code === "browser_cdp_timeout")
      return {
        id: "browser.failure.uncertain",
        message: "The operation took too long. The page is still available; check it before trying again.",
      }
    if (/^browser_load_-2[0-9]{2}$/.test(code) || /ERR_CERT_|ERR_SSL_/.test(message))
      return {
        id: "browser.failure.certificate",
        message:
          "A secure connection could not be established. Check the website address and your device’s date and time.",
      }
    if (code === "browser_load_-106" || /ERR_INTERNET_DISCONNECTED/.test(message))
      return {
        id: "browser.failure.offline",
        message: "You appear to be offline. Check your connection, then retry this page.",
      }
    if (/ERR_NAME_NOT_RESOLVED/.test(message) || code === "browser_load_-105")
      return {
        id: "browser.failure.address",
        message: "The website could not be found. Check the address and try again.",
      }
    if (/ERR_PROXY_|ERR_TUNNEL_/.test(message))
      return {
        id: "browser.failure.proxy",
        message: "The proxy connection failed. Check your proxy settings, then retry.",
      }
    if (code === "browser_navigation_denied")
      return {
        id: "browser.failure.denied",
        message: "This address cannot be opened with the current browser permissions.",
      }
    if (code.startsWith("browser_native_") || code === "browser_host_unavailable" || code === "browser_host_timeout")
      return { id: "browser.failure.unavailable", message: "The browser page is unavailable. Retry opening it." }
    return {
      id: "browser.failure.request",
      message: "The page could not complete this request. Check the page and try again.",
    }
  })()
  return {
    ...descriptor,
    details: redactBrowserText(message)
      .replace(/https?:\/\/[^\s<>]+/g, (value) => {
        try {
          return new URL(value).origin + "/…"
        } catch {
          return "[URL]"
        }
      })
      .slice(0, 4_000),
  }
}
