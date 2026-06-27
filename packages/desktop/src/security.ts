import { session, shell, type BrowserWindow, type WebContents } from "electron"

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"])

export function installSessionSecurity(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
}

export function installWindowSecurity(window: BrowserWindow, getAllowedOrigin: () => string | null): void {
  const contents = window.webContents
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedAppNavigation(url, getAllowedOrigin())) return { action: "allow" }
    void openExternalSafely(url)
    return { action: "deny" }
  })
  contents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url, getAllowedOrigin())) return
    event.preventDefault()
    void openExternalSafely(url)
  })
}

export function isAllowedAppNavigation(url: string, allowedOrigin: string | null): boolean {
  if (url.startsWith("data:text/html,")) return true
  if (!allowedOrigin) return false
  try {
    const candidate = new URL(url)
    const allowed = new URL(allowedOrigin)
    return candidate.origin === allowed.origin && LOCALHOST_HOSTS.has(candidate.hostname)
  } catch {
    return false
  }
}

export async function openExternalSafely(url: string): Promise<void> {
  if (!canOpenExternal(url)) return
  await shell.openExternal(url)
}

export function canOpenExternal(url: string): boolean {
  try {
    const parsed = new URL(url)
    return EXTERNAL_PROTOCOLS.has(parsed.protocol)
  } catch {
    return false
  }
}

export function enforceProductionLoading(contents: WebContents, appOrigin: string | null): void {
  contents.on("did-fail-load", (_event, code, description, url) => {
    if (code === -3) return
    if (url && !isAllowedAppNavigation(url, appOrigin)) {
      console.error(`[desktop] blocked failed navigation outside app origin: ${url}`, description)
    }
  })
}
