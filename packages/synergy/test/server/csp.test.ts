import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

function directive(policy: string, name: string) {
  return policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `))
}

describe("Server SPA CSP", () => {
  test("allows Ghostty Web terminal scripts, WASM evaluation, bundled fonts, and app media", () => {
    const policy = Server.spaCsp("nonce123")
    const script = directive(policy, "script-src")

    expect(script).toContain("'unsafe-inline'")
    expect(script).toContain("'wasm-unsafe-eval'")
    expect(directive(policy, "font-src")).toContain("data:")
    expect(directive(policy, "connect-src")).toContain("blob:")
    expect(directive(policy, "connect-src")).toContain("data:")
    expect(directive(policy, "media-src")).toContain("'self'")
  })
})
