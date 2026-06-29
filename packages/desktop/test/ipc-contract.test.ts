import { describe, expect, test } from "bun:test"
import { parseBrowserNativeAttach, parseBrowserNativeResize, parseExternalUrl } from "../src/ipc-contract.js"

describe("desktop ipc contract", () => {
  test("accepts valid browser native attach payloads", () => {
    expect(
      parseBrowserNativeAttach({
        sessionID: "session",
        pageId: "page",
        serverUrl: "http://127.0.0.1:3000",
        url: "https://example.com",
        bounds: { x: 0, y: 0, width: 640, height: 480 },
      }),
    ).toEqual({
      sessionID: "session",
      pageId: "page",
      serverUrl: "http://127.0.0.1:3000",
      url: "https://example.com",
      bounds: { x: 0, y: 0, width: 640, height: 480 },
    })
  })

  test("rejects malformed browser native payloads", () => {
    expect(() => parseBrowserNativeResize({ pageId: "page", bounds: { width: -1, height: 1, x: 0, y: 0 } })).toThrow()
    expect(() => parseBrowserNativeAttach({ sessionID: "session", pageId: "page", extra: true })).toThrow()
  })

  test("allows only safe external protocols", () => {
    expect(parseExternalUrl("https://example.com")).toBe("https://example.com")
    expect(parseExternalUrl("mailto:hello@example.com")).toBe("mailto:hello@example.com")
    expect(() => parseExternalUrl("file:///etc/passwd")).toThrow()
    expect(() => parseExternalUrl("javascript:alert(1)")).toThrow()
  })
})
