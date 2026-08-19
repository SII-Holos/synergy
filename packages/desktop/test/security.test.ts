import { describe, expect, test } from "bun:test"
import { electronMockState, registerElectronMock } from "./electron-mock"

registerElectronMock()

const { enforceProductionLoading, installSessionSecurity, installWindowSecurity, openExternalSafely } = await import(
  "../src/security.js"
)

describe("desktop session security", () => {
  test("denies every renderer permission request by default", () => {
    electronMockState.permissionRequestHandlers = []
    installSessionSecurity()
    expect(electronMockState.permissionRequestHandlers).toHaveLength(1)

    const decisions: boolean[] = []
    electronMockState.permissionRequestHandlers[0]!(null, "media", (granted) => decisions.push(granted))
    electronMockState.permissionRequestHandlers[0]!(null, "geolocation", (granted) => decisions.push(granted))
    expect(decisions).toEqual([false, false])
  })

  test("opens only http, https, and mailto URLs externally", async () => {
    electronMockState.shellOpened = []
    await openExternalSafely("https://example.com/docs")
    await openExternalSafely("http://localhost:3000")
    await openExternalSafely("mailto:hi@example.com")
    await openExternalSafely("file:///etc/passwd")
    await openExternalSafely("javascript:alert(1)")
    await openExternalSafely("not a url")

    expect(electronMockState.shellOpened).toEqual([
      "https://example.com/docs",
      "http://localhost:3000",
      "mailto:hi@example.com",
    ])
  })

  test("allows same-origin localhost window opens and denies everything else through the shell", async () => {
    electronMockState.shellOpened = []
    const windowOpenHandlers: Array<(details: { url: string }) => { action: string }> = []
    const navigationHandlers: Array<(event: { prevented: boolean; preventDefault(): void }, url: string) => void> = []
    const window = {
      webContents: {
        setWindowOpenHandler(handler: never) {
          windowOpenHandlers.push(handler)
        },
        on(_event: string, handler: never) {
          navigationHandlers.push(handler)
        },
      },
    }

    installWindowSecurity(window as never, () => "http://127.0.0.1:8765")

    const open = windowOpenHandlers[0]!
    expect(open({ url: "http://127.0.0.1:8765/session" })).toEqual({ action: "allow" })
    expect(open({ url: "https://evil.example.com" })).toEqual({ action: "deny" })
    expect(open({ url: "file:///etc/passwd" })).toEqual({ action: "deny" })
    await Bun.sleep(0)
    expect(electronMockState.shellOpened).toEqual(["https://evil.example.com"])

    electronMockState.shellOpened = []
    const navigate = navigationHandlers[0]!
    const allowedEvent = {
      prevented: false,
      preventDefault() {
        this.prevented = true
      },
    }
    navigate(allowedEvent, "http://127.0.0.1:8765/session")
    expect(allowedEvent.prevented).toBe(false)

    const deniedEvent = {
      prevented: false,
      preventDefault() {
        this.prevented = true
      },
    }
    navigate(deniedEvent, "https://evil.example.com")
    expect(deniedEvent.prevented).toBe(true)
    await Bun.sleep(0)
    expect(electronMockState.shellOpened).toEqual(["https://evil.example.com"])
  })

  test("reports failed loads outside the app origin and ignores the aborted code", () => {
    const errors: Array<Array<unknown>> = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      const handlers: Array<(event: unknown, code: number, description: string, url: string) => void> = []
      const contents = {
        on(_event: string, handler: never) {
          handlers.push(handler)
        },
      }

      enforceProductionLoading(contents as never, () => "http://127.0.0.1:8765")
      const failed = handlers[0]!

      failed(null, -3, "aborted", "https://evil.example.com")
      failed(null, -105, "unreachable", "http://127.0.0.1:8765/page")
      failed(null, -105, "unreachable", "https://evil.example.com/page")
      failed(null, -105, "unreachable", "")

      expect(errors).toHaveLength(1)
      expect(errors[0]![0]).toContain("blocked failed navigation outside app origin")
      expect(errors[0]![0]).toContain("https://evil.example.com/page")
    } finally {
      console.error = original
    }
  })
})
