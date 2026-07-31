import type { BrowserHostStatus } from "@ericsanchezok/synergy-browser"
import type { BrowserWebRTCStatus } from "./browser-webrtc"

export function shouldShowBrowserPresentationSurface(input: {
  presentation: "native" | "webrtc" | undefined
  hostStatus: BrowserHostStatus
  nativeAvailable: boolean
  pageId: string | null
}): boolean {
  if (!input.pageId) return false
  if (input.presentation === "webrtc") return true
  return input.presentation === "native" && input.nativeAvailable && input.hostStatus === "ready"
}

export function webRTCHostStatus(status: BrowserWebRTCStatus): "pending" | "ready" | undefined {
  if (status === "host_pending") return "pending"
  if (status === "host_ready") return "ready"
}
