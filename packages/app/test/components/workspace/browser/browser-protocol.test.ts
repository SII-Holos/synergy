import { describe, expect, test } from "bun:test"
import {
  BROWSER_PROTOCOL_VERSION,
  parseBrowserPresentationPreference,
  selectBrowserPresentation,
} from "@ericsanchezok/synergy-browser"

describe("browser presentation negotiation", () => {
  test("chooses native for desktop local clients", () => {
    const selected = selectBrowserPresentation({
      desktopLocalHost: true,
      remote: false,
      requested: "auto",
      capabilities: { native: true, webrtc: true },
    })

    expect(selected?.protocolVersion).toBe(BROWSER_PROTOCOL_VERSION)
    expect(selected?.kind).toBe("native")
    expect(selected?.reason).toBe("desktop-local")
    expect(selected?.capabilities).toEqual({ native: true, webrtc: true })
  })

  test("chooses WebRTC for remote web clients", () => {
    const selected = selectBrowserPresentation({
      desktopLocalHost: false,
      remote: true,
      requested: "auto",
      capabilities: { native: true, webrtc: true },
    })

    expect(selected?.kind).toBe("webrtc")
    expect(selected?.reason).toBe("remote-client")
    expect(selected?.capabilities).toEqual({ native: true, webrtc: true })
  })

  test("honors explicit requests and parses unknown values as auto", () => {
    expect(parseBrowserPresentationPreference("native")).toBe("native")
    expect(parseBrowserPresentationPreference("jpeg-ws")).toBe("auto")
    expect(
      selectBrowserPresentation({
        desktopLocalHost: false,
        remote: true,
        requested: "native",
        capabilities: { native: true, webrtc: true },
      })?.kind,
    ).toBe("webrtc")
    expect(
      selectBrowserPresentation({
        desktopLocalHost: false,
        remote: true,
        capabilities: { native: false, webrtc: false },
      }),
    ).toBeNull()
  })
})
