import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

function directive(policy: string, name: string) {
  return policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `))
}

describe("Server SPA CSP", () => {
  test("allows hashed theme preload, nonce route script, bundled fonts, and app media", () => {
    const policy = Server.spaCsp("nonce123")
    const script = directive(policy, "script-src")

    expect(script).toContain("'sha256-Qf8GAcLAwW4P3mUyGKGC4j67XnDPP6d00NW/TNjPNE0='")
    expect(script).toContain("'nonce-nonce123'")
    expect(script).not.toContain("unsafe-inline")
    expect(directive(policy, "font-src")).toContain("data:")
    expect(directive(policy, "media-src")).toContain("'self'")
  })
})
