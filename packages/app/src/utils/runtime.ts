import { proxyPrefix } from "@/utils/proxy"

export interface AppAccess {
  attachUrl: string
  callbackUrl: string
}

function trimSlashes(value: string) {
  return value.replace(/\/+$/, "")
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value)
}

export function envFlag(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

function browserBaseUrl() {
  const prefix = proxyPrefix()
  if (prefix) return trimSlashes(window.location.origin + prefix)
  return trimSlashes(window.location.origin)
}

export function isHostedMode() {
  return envFlag(import.meta.env.VITE_SYNERGY_HOSTED)
}

export function allowDebugUrl() {
  return envFlag(import.meta.env.VITE_SYNERGY_ALLOW_DEBUG_URL)
}

export function controlApiBase() {
  return trimSlashes(import.meta.env.VITE_SYNERGY_CONTROL_API_BASE || window.location.origin)
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

export function appAccessFromUrlParam(): AppAccess | undefined {
  if (!allowDebugUrl()) return

  const param = new URLSearchParams(document.location.search).get("url")
  if (!param || !isHttpUrl(param)) return
  return fromAttachUrl(param)
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
