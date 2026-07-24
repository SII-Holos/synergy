export const DESKTOP_APP_ID = "io.holosai.synergy"
export const DESKTOP_PRODUCT_NAME = "Synergy"
export const DESKTOP_EXECUTABLE_NAME = "synergy-desktop"
export const DESKTOP_PROTOCOL = "synergy"

export type DesktopChannel = "dev" | "stable"
export type DesktopServerMode = "managed" | "external"

export function desktopChannel(isPackaged = false): DesktopChannel {
  const channel = process.env.SYNERGY_DESKTOP_CHANNEL
  if (channel === "stable" || channel === "dev") return channel
  return isPackaged ? "stable" : "dev"
}

export function desktopWindowTitle(channel: DesktopChannel): string {
  return channel === "dev" ? `${DESKTOP_PRODUCT_NAME} Dev` : DESKTOP_PRODUCT_NAME
}

export function desktopAppUserModelId(channel: DesktopChannel): string {
  return channel === "dev" ? `${DESKTOP_APP_ID}.dev` : DESKTOP_APP_ID
}

export function applyDesktopAppIdentity(
  target: { name: string; setAppUserModelId(id: string): void },
  channel: DesktopChannel,
): void {
  target.name = DESKTOP_PRODUCT_NAME
  try {
    target.setAppUserModelId(desktopAppUserModelId(channel))
  } catch {
    // AppUserModelId is only meaningful on Windows.
  }
}

export function applyReadyDesktopAppName(target: { setName(name: string): void }): void {
  target.setName(DESKTOP_PRODUCT_NAME)
}

export function desktopServerMode(channel: DesktopChannel): DesktopServerMode {
  const mode = process.env.SYNERGY_DESKTOP_SERVER_MODE
  if (mode === "managed" || mode === "external") return mode
  if (channel === "dev" && process.env.SYNERGY_DESKTOP_APP_URL) return "external"
  return "managed"
}

export function isDebugEnabled(channel: DesktopChannel): boolean {
  return channel === "dev" || process.env.SYNERGY_DESKTOP_DEBUG === "1"
}
