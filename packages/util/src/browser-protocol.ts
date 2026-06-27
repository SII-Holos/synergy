export const BROWSER_PROTOCOL_VERSION = 1

export const BrowserPresentationKinds = ["native", "webrtc"] as const
export type BrowserPresentationKind = (typeof BrowserPresentationKinds)[number]

export type BrowserPresentationPreference = "auto" | BrowserPresentationKind

export function parseBrowserPresentationPreference(value: string | null | undefined): BrowserPresentationPreference {
  if (value === "native" || value === "webrtc") return value
  return "auto"
}

export function normalizeBrowserURL(input: string, base?: string): string {
  const raw = input.trim()
  if (!raw) throw new Error("URL is required")

  if (/^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?(\/.*)?$/i.test(raw)) {
    return `http://${raw}`
  }

  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?(\/.*)?$/.test(raw)) {
    return `https://${raw}`
  }

  if (base || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) {
    try {
      return new URL(raw, base).toString()
    } catch {
      // Continue to search fallback below.
    }
  }

  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`
}

export interface BrowserPresentationCapabilities {
  native: boolean
  webrtc: boolean
}

export interface BrowserPresentationSelection {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION
  kind: BrowserPresentationKind
  capabilities: BrowserPresentationCapabilities
  reason: "desktop-local" | "remote-client" | "requested"
}

export interface BrowserPresentationEnvironment {
  desktop: boolean
  sameHost: boolean
  remote: boolean
  requested?: BrowserPresentationPreference
  capabilities?: Partial<BrowserPresentationCapabilities>
}

export interface BrowserPage {
  id: string
  url: string
  title: string
  isLoading: boolean
  lastActiveAt?: number | null
}

export interface BrowserSession {
  page: BrowserPage | null
}

export interface BrowserPresentation {
  selection: BrowserPresentationSelection
}

export interface BrowserControl {
  navigate(input: { pageId?: string; url: string }): Promise<{ url: string; title: string }>
  reload(input?: { pageId?: string }): Promise<void>
  stop(input?: { pageId?: string }): Promise<void>
  setViewport(input: { pageId?: string; width: number; height: number }): Promise<void>
  snapshot(input?: { pageId?: string }): Promise<unknown>
  screenshot(input?: { pageId?: string }): Promise<{ dataUrl: string; width: number; height: number }>
}

export interface BrowserHost {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION
  capabilities(): Promise<BrowserPresentationCapabilities> | BrowserPresentationCapabilities
  presentation(input: BrowserPresentationEnvironment): BrowserPresentationSelection
  session(input: { ownerKey: string }): Promise<BrowserSession>
  control(input: { ownerKey: string }): Promise<BrowserControl>
}

const defaultCapabilities: BrowserPresentationCapabilities = {
  native: true,
  webrtc: true,
}

function capabilities(input?: Partial<BrowserPresentationCapabilities>): BrowserPresentationCapabilities {
  return {
    native: input?.native ?? defaultCapabilities.native,
    webrtc: input?.webrtc ?? defaultCapabilities.webrtc,
  }
}

export function selectBrowserPresentation(input: BrowserPresentationEnvironment): BrowserPresentationSelection {
  const caps = capabilities(input.capabilities)
  const requested = input.requested ?? "auto"

  if (requested === "native" && caps.native) {
    return { protocolVersion: BROWSER_PROTOCOL_VERSION, kind: "native", capabilities: caps, reason: "requested" }
  }
  if (requested === "webrtc" && caps.webrtc) {
    return { protocolVersion: BROWSER_PROTOCOL_VERSION, kind: "webrtc", capabilities: caps, reason: "requested" }
  }
  if (caps.native && input.desktop && input.sameHost && !input.remote) {
    return { protocolVersion: BROWSER_PROTOCOL_VERSION, kind: "native", capabilities: caps, reason: "desktop-local" }
  }
  return { protocolVersion: BROWSER_PROTOCOL_VERSION, kind: "webrtc", capabilities: caps, reason: "remote-client" }
}

export type BrowserWebRTCSignalMessage =
  | { type: "webrtc.offer"; pageId: string; sdp: string; traceId?: string }
  | { type: "webrtc.answer"; pageId: string; sdp: string }
  | { type: "webrtc.ice"; pageId: string; candidate: unknown; traceId?: string }
  | { type: "webrtc.close"; pageId: string; traceId?: string }
