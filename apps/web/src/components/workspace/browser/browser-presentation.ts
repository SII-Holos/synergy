import type { BrowserHostStatus } from "@ericsanchezok/synergy-browser-core"

export function shouldShowBrowserPresentationSurface(input: {
  presentation: "native" | undefined
  clientPresentation?: "native"
  hostStatus: BrowserHostStatus
  nativeAvailable: boolean
  pageId: string | null
}): boolean {
  if (!input.pageId) return false
  if (input.clientPresentation === "native" && input.presentation !== "native") return false
  return input.presentation === "native" && input.nativeAvailable && input.hostStatus === "ready"
}
