import { describe, expect, test } from "bun:test"
import { base64Decode, base64Encode, base64EncodeStandard, checksum, hash } from "../src/encode"

describe("base64Encode / base64Decode", () => {
  test("round-trips plain text", () => {
    for (const value of ["hello", "synergy", "héllo wörld", "emoji: 🚀"]) {
      expect(base64Decode(base64Encode(value))).toBe(value)
    }
  })

  test("encodes URL-safe base64 without padding or reserved characters", () => {
    const encoded = base64Encode("hello world!??")
    expect(encoded).not.toMatch(/[+/=]/)
    expect(base64Decode(encoded)).toBe("hello world!??")
  })

  test("decodes URL-safe variants directly", () => {
    expect(base64Decode("aGVsbG8td29ybGQ")).toBe("hello-world")
    expect(base64Decode("aGVsbG8vd29ybGQ")).toBe("hello/world")
    expect(base64Decode("aGVsbG8rd29ybGQ")).toBe("hello+world")
  })
  test("base64EncodeStandard produces RFC 4648 output with padding", () => {
    expect(base64EncodeStandard("hello")).toBe("aGVsbG8=")
    expect(base64EncodeStandard("hello world!??")).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(base64EncodeStandard("hello world!??")).not.toMatch(/[-_]/)
  })

  test("base64EncodeStandard round-trips through a strict atob decoder", () => {
    for (const value of ["hello", "héllo wörld", "emoji: 🚀", '<session-ref id="ses_x" />']) {
      const encoded = base64EncodeStandard(value)
      const binary = atob(encoded)
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
      expect(new TextDecoder().decode(bytes)).toBe(value)
    }
  })
})
describe("hash", () => {
  test("produces standard SHA-256 hex digests", async () => {
    expect(await hash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })

  test("supports alternate algorithms", async () => {
    expect(await hash("abc", "SHA-1")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d")
  })

  test("distinguishes different content", async () => {
    const [left, right] = await Promise.all([hash("same"), hash("different content")])
    expect(left).not.toBe(right)
    expect(left).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("checksum", () => {
  test("returns undefined for empty input", () => {
    expect(checksum("")).toBeUndefined()
  })

  test("is deterministic and format-stable", () => {
    expect(checksum("hello")).toBe(checksum("hello"))
    expect(checksum("hello")).not.toBe(checksum("world"))
    expect(checksum("hello")).toMatch(/^[0-9a-z]+$/)
  })
})
