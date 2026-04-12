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

function trimPathSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, "")
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

function readUrlParamAccess() {
  const param = new URLSearchParams(document.location.search).get("url")
  if (!param || !isHttpUrl(param)) return
  return trimSlashes(param)
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
  const fromUrl = readUrlParamAccess()
  if (fromUrl) return fromAttachUrl(fromUrl)

  if (!isHostedMode()) {
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

  const endpoint = import.meta.env.VITE_SYNERGY_ATTACH_URL_ENDPOINT
  if (!endpoint) {
    throw new Error("Hosted mode requires VITE_SYNERGY_ATTACH_URL_ENDPOINT or a ?url=... override.")
  }

  const response = await fetch(endpoint, {
    credentials: "include",
    headers: {
      accept: "application/json",
    },
  })

  let data: Record<string, unknown> | undefined
  try {
    data = (await response.json()) as Record<string, unknown>
  } catch {
    data = undefined
  }

  if (!response.ok) {
    const message =
      (typeof data?.message === "string" && data.message) ||
      (typeof data?.error === "string" && data.error) ||
      `Failed to fetch Synergy access URL (${response.status})`
    throw new Error(message)
  }

  const attachUrl =
    (typeof data?.attachUrl === "string" && data.attachUrl) || (typeof data?.url === "string" && data.url) || ""
  if (!isHttpUrl(attachUrl)) {
    throw new Error("Synergy access API did not return a valid attachUrl.")
  }

  return fromAttachUrl(attachUrl)
}
