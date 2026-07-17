import { createHmac } from "crypto"
import { describe, expect, test } from "bun:test"
import { verifyGitHubSignature } from "../../src/github/webhook"

function signature(body: string, secret: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

describe("GitHub webhook HMAC verification", () => {
  test("accepts the exact raw request body", () => {
    const body = '{"action":"opened","body":"é"}'
    expect(verifyGitHubSignature(new TextEncoder().encode(body), signature(body, "secret"), "secret")).toBe(true)
  })

  test("rejects tampering, malformed values, and missing secrets", () => {
    const body = '{"action":"opened"}'
    const valid = signature(body, "secret")

    expect(verifyGitHubSignature(new TextEncoder().encode(body + " "), valid, "secret")).toBe(false)
    expect(verifyGitHubSignature(new TextEncoder().encode(body), valid, "other-secret")).toBe(false)
    expect(verifyGitHubSignature(new TextEncoder().encode(body), "sha1=abc", "secret")).toBe(false)
    expect(verifyGitHubSignature(new TextEncoder().encode(body), "sha256=abc", "secret")).toBe(false)
    expect(verifyGitHubSignature(new TextEncoder().encode(body), undefined, "secret")).toBe(false)
    expect(verifyGitHubSignature(new TextEncoder().encode(body), valid, undefined)).toBe(false)
  })
})
