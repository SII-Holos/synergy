import { describe, expect, test } from "bun:test"
import { urlBase64ToUint8Array } from "../../src/utils/web-push"

describe("urlBase64ToUint8Array", () => {
  test("decodes URL-safe base64 without padding", () => {
    // "hello" in base64 = aGVsbG8=; URL-safe variant drops the padding
    const result = urlBase64ToUint8Array("aGVsbG8")
    expect([...result]).toEqual([104, 101, 108, 108, 111])
  })

  test("decodes base64url with - and _ characters", () => {
    // 0xFF 0xEE 0xDD -> /+7d in standard base64 -> _-7d in base64url
    const result = urlBase64ToUint8Array("_-7d")
    expect([...result]).toEqual([255, 238, 221])
  })

  test("returns a Uint8Array backed by ArrayBuffer (BufferSource-compatible)", () => {
    const result = urlBase64ToUint8Array("aGVsbG8")
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result.buffer).toBeInstanceOf(ArrayBuffer)
  })
})
