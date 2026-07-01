import type { Platform, DesktopWindowState } from "@/context/platform"
import type { SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"

export function desktopWindowChromeVisible(platform: Pick<Platform, "platform" | "desktopWindow">): boolean {
  return platform.platform === "desktop" && platform.desktopWindow?.chrome === "custom"
}

export function desktopWindowToggleIcon(state: DesktopWindowState | null | undefined): SemanticIconTokenName {
  return state?.maximized || state?.fullscreen ? "window.restore" : "window.maximize"
}

export function desktopWindowToggleLabel(state: DesktopWindowState | null | undefined): string {
  return state?.maximized || state?.fullscreen ? "Restore" : "Maximize"
}
