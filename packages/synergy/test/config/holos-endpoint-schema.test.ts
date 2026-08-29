import { describe, expect, test } from "bun:test"
import { Holos } from "../../src/config/schema"
import { validateHolosEndpoint, validateHolosPortalUrl } from "../../src/holos/security"

describe("Holos endpoint validation", () => {
  test("rejects base URLs whose path contains an api segment", () => {
    expect(() => validateHolosEndpoint("https://host.example/api/v1/holos", "api")).toThrow()
    expect(() => validateHolosEndpoint("https://host.example/api", "api")).toThrow()
    expect(() => validateHolosEndpoint("wss://host.example/gateway/api/tunnel", "ws")).toThrow()
  })

  test("accepts origins and path prefixes without an api segment", () => {
    expect(validateHolosEndpoint("https://api.holosai.io", "api").toString()).toBe("https://api.holosai.io/")
    expect(validateHolosEndpoint("https://host.example/environment", "api").pathname).toBe("/environment")
    expect(validateHolosEndpoint("ws://127.0.0.1:8787/environment", "ws").pathname).toBe("/environment")
  })

  test("validates every holos config domain endpoint", () => {
    expect(
      Holos.safeParse({
        apiUrl: "https://api.example.test",
        wsUrl: "wss://api.example.test",
        portalUrl: "https://portal.example.test",
      }).success,
    ).toBe(true)
    expect(Holos.safeParse({ apiUrl: "http://127.0.0.1:8787/environment" }).success).toBe(true)
  })

  test("rejects invalid holos config domain endpoints", () => {
    expect(Holos.safeParse({ apiUrl: "https://api.example.test/api/v1/holos" }).success).toBe(false)
    expect(Holos.safeParse({ apiUrl: "ftp://api.example.test" }).success).toBe(false)
    expect(Holos.safeParse({ apiUrl: "https://api.example.test/endpoint?token=1" }).success).toBe(false)
    expect(Holos.safeParse({ wsUrl: "https://api.example.test" }).success).toBe(false)
    expect(Holos.safeParse({ wsUrl: "wss://host.example/gateway/api" }).success).toBe(false)
    expect(Holos.safeParse({ portalUrl: "http://portal.example.test" }).success).toBe(false)
    expect(Holos.safeParse({ portalUrl: "https://portal.example.test/bind#fragment" }).success).toBe(false)
    expect(Holos.safeParse({ portalUrl: "not a url" }).success).toBe(false)
  })

  test("portal URLs allow https and loopback http only, without query or fragment", () => {
    expect(validateHolosPortalUrl("https://portal.example.test").hostname).toBe("portal.example.test")
    expect(validateHolosPortalUrl("http://127.0.0.1:3000/environment").pathname).toBe("/environment")
    expect(() => validateHolosPortalUrl("http://portal.example.test")).toThrow()
    expect(() => validateHolosPortalUrl("https://portal.example.test/start?next=1")).toThrow()
    expect(() => validateHolosPortalUrl("https://user:pass@portal.example.test")).toThrow()
  })
})
