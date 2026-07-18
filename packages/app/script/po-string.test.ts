import { describe, expect, test } from "bun:test"
import { decodePoString } from "./po-string"

describe("decodePoString", () => {
  test("decodes only supported PO escapes", () => {
    expect(decodePoString('quote: \\"; path: C:\\\\tmp; lines: one\\ntwo\\tend\\r')).toBe(
      'quote: "; path: C:\\tmp; lines: one\ntwo\tend\r',
    )
  })

  test("rejects malformed or unsupported escapes", () => {
    expect(() => decodePoString("trailing\\")).toThrow("Trailing backslash")
    expect(() => decodePoString("unicode\\u4e2d")).toThrow("Unsupported PO escape")
  })
})
