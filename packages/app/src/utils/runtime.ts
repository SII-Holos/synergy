export interface AppAccess {
  attachUrl: string
  callbackUrl: string
}

declare global {
  interface Window {
    __SYNERGY_ROUTE__?: string
  }
}

function trimSlashes(value: string) {
  return value.replace(/\/+$/, "")
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value)
}

export function proxyPrefix() {
  const route = window.__SYNERGY_ROUTE__
  if (route != null) {
    const fullPath = window.location.pathname
    if (fullPath !== route && fullPath.endsWith(route)) {
      return fullPath.slice(0, fullPath.length - route.length).replace(/\/+$/, "")
    }
  }
  return ""
}

function browserBaseUrl() {
  const prefix = proxyPrefix()
  if (prefix) return trimSlashes(window.location.origin + prefix)
  return trimSlashes(window.location.origin)
}

export function isHostedMode() {
  const value = import.meta.env.VITE_SYNERGY_HOSTED
  return value === "1" || value === "true"
}

export function appAccessFromUrlParam(): AppAccess | undefined {
  const param = new URLSearchParams(document.location.search).get("url")
  if (!param || !isHttpUrl(param)) return
  return fromAttachUrl(param)
}

export function callbackUrlFor(attachUrl: string) {
  return `${trimSlashes(attachUrl)}/holos/callback`
}

function fromAttachUrl(attachUrl: string): AppAccess {
  const normalized = trimSlashes(attachUrl)
  return {
    attachUrl: normalized,
    callbackUrl: callbackUrlFor(normalized),
  }
}

export async function resolveAppAccess(): Promise<AppAccess> {
  const fromUrl = appAccessFromUrlParam()
  if (fromUrl) return fromUrl

  const attachUrl = import.meta.env.DEV
    ? (import.meta.env.VITE_SYNERGY_SERVER_URL ?? "http://localhost:4096")
    : browserBaseUrl()
  return {
    attachUrl,
    callbackUrl: import.meta.env.DEV
      ? (import.meta.env.VITE_SYNERGY_CALLBACK_URL ?? callbackUrlFor(attachUrl))
      : callbackUrlFor(attachUrl),
  }
}
