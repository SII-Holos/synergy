import type { Session } from "electron"

const browserNetworkPermissions = new Set(["local-network-access", "local-network", "loopback-network"])
const browserPermissionUsers = new WeakMap<Session, number>()

export function isBrowserNetworkPermission(permission: string): boolean {
  return browserNetworkPermissions.has(permission)
}

export function installBrowserContentPermissions(session: Session): void {
  const users = browserPermissionUsers.get(session) ?? 0
  browserPermissionUsers.set(session, users + 1)
  if (users > 0) return
  session.setPermissionCheckHandler((_webContents, permission) => isBrowserNetworkPermission(String(permission)))
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isBrowserNetworkPermission(String(permission)))
  })
}

export function clearBrowserContentPermissions(session: Session): void {
  const users = browserPermissionUsers.get(session) ?? 0
  if (users > 1) {
    browserPermissionUsers.set(session, users - 1)
    return
  }
  browserPermissionUsers.delete(session)
  session.setPermissionCheckHandler(null)
  session.setPermissionRequestHandler(null)
}
