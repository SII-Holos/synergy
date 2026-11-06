import { expect, test } from "bun:test"
import { DaemonService } from "../../src/daemon/service"
import { DaemonUnsupportedPlatformError } from "../../src/daemon/error"

test("service selection loads only the selected manager and rejects unsupported platforms before operations", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!
  try {
    for (const [platform, manager] of [
      ["darwin", "launchd"],
      ["linux", "systemd-user"],
      ["win32", "schtasks"],
    ] as const) {
      Object.defineProperty(process, "platform", { value: platform, configurable: true })
      expect((await DaemonService.resolve()).manager).toBe(manager)
    }
    Object.defineProperty(process, "platform", { value: "freebsd", configurable: true })
    try {
      await DaemonService.resolve()
      throw new Error("unsupported platform resolved")
    } catch (error) {
      expect(DaemonUnsupportedPlatformError.isInstance(error)).toBe(true)
    }
  } finally {
    Object.defineProperty(process, "platform", descriptor)
  }
})
