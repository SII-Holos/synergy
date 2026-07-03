import { session, shell, type BrowserWindow, type WebContents } from "electron"
import { canOpenExternal, isAllowedAppNavigation } from "./navigation-policy.js"

export { canOpenExternal, isAllowedAppNavigation } from "./navigation-policy.js"

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

export async function openExternalSafely(url: string): Promise<void> {
  if (!canOpenExternal(url)) return
  await shell.openExternal(url)
}

export function enforceProductionLoading(contents: WebContents, getAppOrigin: () => string | null): void {
  contents.on("did-fail-load", (_event, code, description, url) => {
    if (code === -3) return
    if (url && !isAllowedAppNavigation(url, getAppOrigin())) {
      console.error(`[desktop] blocked failed navigation outside app origin: ${url}`, description)
    }
  })
}
