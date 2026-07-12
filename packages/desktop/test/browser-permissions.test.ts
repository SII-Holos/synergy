import { describe, expect, test } from "bun:test"
import { isBrowserNetworkPermission } from "../src/browser-permissions"

describe("Browser content permissions", () => {
  test("allows Chromium network permissions without granting unrelated browser capabilities", () => {
    expect(isBrowserNetworkPermission("local-network-access")).toBe(true)
    expect(isBrowserNetworkPermission("local-network")).toBe(true)
    expect(isBrowserNetworkPermission("loopback-network")).toBe(true)
    expect(isBrowserNetworkPermission("media")).toBe(false)
    expect(isBrowserNetworkPermission("geolocation")).toBe(false)
    expect(isBrowserNetworkPermission("fileSystem")).toBe(false)
  })
})
