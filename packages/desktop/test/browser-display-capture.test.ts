import { describe, expect, test } from "bun:test"
import { isBrowserDisplayCapturePermission, startBrowserDisplayCapture } from "../src/browser-display-capture"

describe("Browser Host display capture", () => {
  test("accepts Electron display-capture permission names only", () => {
    expect(isBrowserDisplayCapturePermission("media")).toBe(true)
    expect(isBrowserDisplayCapturePermission("display-capture")).toBe(true)
    expect(isBrowserDisplayCapturePermission("geolocation")).toBe(false)
  })

  test("starts the trusted controller capture with a simulated user gesture", async () => {
    let userGesture = false
    const contents = {
      async executeJavaScript(code: string, gesture?: boolean) {
        userGesture = gesture === true
        expect(code).toContain("startCapture()")
        return { ok: true }
      },
    }

    await startBrowserDisplayCapture(contents, 100)
    expect(userGesture).toBe(true)
  })

  test("bounds a controller capture that never settles", async () => {
    const contents = {
      executeJavaScript() {
        return new Promise<never>(() => {})
      },
    }

    await expect(startBrowserDisplayCapture(contents, 5)).rejects.toThrow("timed out")
  })

  test("preserves a controller capture error across the Electron execution boundary", async () => {
    const contents = {
      executeJavaScript() {
        return Promise.resolve({ ok: false, message: "NotAllowedError: Permission denied" })
      },
    }

    await expect(startBrowserDisplayCapture(contents, 100)).rejects.toThrow(
      "Browser Host display capture failed: NotAllowedError: Permission denied",
    )
  })
})
