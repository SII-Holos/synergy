import { describe, expect, test } from "bun:test"
import {
  clearBrowserContentPermissions,
  installBrowserContentPermissions,
  isBrowserNetworkPermission,
} from "../src/browser-permissions"

describe("Browser content permissions", () => {
  test("allows Chromium network permissions without granting unrelated browser capabilities", () => {
    expect(isBrowserNetworkPermission("local-network-access")).toBe(true)
    expect(isBrowserNetworkPermission("local-network")).toBe(true)
    expect(isBrowserNetworkPermission("loopback-network")).toBe(true)
    expect(isBrowserNetworkPermission("media")).toBe(false)
    expect(isBrowserNetworkPermission("geolocation")).toBe(false)
    expect(isBrowserNetworkPermission("fileSystem")).toBe(false)
  })

  test("keeps shared partition handlers installed while a replacement generation is live", () => {
    const checkHandlers: unknown[] = []
    const requestHandlers: unknown[] = []
    const session = {
      setPermissionCheckHandler(handler: unknown) {
        checkHandlers.push(handler)
      },
      setPermissionRequestHandler(handler: unknown) {
        requestHandlers.push(handler)
      },
    }

    installBrowserContentPermissions(session as never)
    installBrowserContentPermissions(session as never)
    clearBrowserContentPermissions(session as never)

    expect(checkHandlers).toHaveLength(1)
    expect(requestHandlers).toHaveLength(1)

    clearBrowserContentPermissions(session as never)
    expect(checkHandlers.at(-1)).toBeNull()
    expect(requestHandlers.at(-1)).toBeNull()
  })
})
