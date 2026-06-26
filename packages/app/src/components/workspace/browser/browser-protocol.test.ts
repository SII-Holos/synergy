import { describe, expect, test } from "bun:test"
import {
  BROWSER_PROTOCOL_VERSION,
  parseBrowserPresentationPreference,
  selectBrowserPresentation,
} from "@ericsanchezok/synergy-util/browser-protocol"

describe("browser presentation negotiation", () => {
  test("chooses native for desktop local clients", () => {
    const selected = selectBrowserPresentation({
      desktop: true,
      sameHost: true,
      remote: false,
      requested: "auto",
    })

    expect(selected.protocolVersion).toBe(BROWSER_PROTOCOL_VERSION)
    expect(selected.kind).toBe("native")
    expect(selected.reason).toBe("desktop-local")
    expect(selected.capabilities.screenshotFallback).toBe(false)
  })

  test("chooses WebRTC for remote web clients", () => {
    const selected = selectBrowserPresentation({
      desktop: false,
      sameHost: false,
      remote: true,
      requested: "auto",
    })

    expect(selected.kind).toBe("webrtc")
    expect(selected.reason).toBe("remote-client")
    expect(selected.capabilities).not.toHaveProperty("jpeg")
  })

  test("honors explicit requests and parses unknown values as auto", () => {
    expect(parseBrowserPresentationPreference("native")).toBe("native")
    expect(parseBrowserPresentationPreference("jpeg-ws")).toBe("auto")
    expect(selectBrowserPresentation({ desktop: false, sameHost: false, remote: true, requested: "native" }).kind).toBe(
      "native",
    )
  })
})
