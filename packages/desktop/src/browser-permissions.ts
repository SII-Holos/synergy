import type { Session } from "electron"

const browserNetworkPermissions = new Set(["local-network-access", "local-network", "loopback-network"])

export function isBrowserNetworkPermission(permission: string): boolean {
  return browserNetworkPermissions.has(permission)
}

export function installBrowserContentPermissions(session: Session): void {
  session.setPermissionCheckHandler((_webContents, permission) => isBrowserNetworkPermission(String(permission)))
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isBrowserNetworkPermission(String(permission)))
  })
}

export function clearBrowserContentPermissions(session: Session): void {
  session.setPermissionCheckHandler(null)
  session.setPermissionRequestHandler(null)
}
