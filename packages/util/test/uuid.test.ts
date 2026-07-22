import { describe, expect, test } from "bun:test"
import { generateUUID, type UUIDCrypto } from "../src/uuid"

describe("generateUUID", () => {
  test("uses native randomUUID when available", () => {
    expect(
      generateUUID({
        crypto: { randomUUID: () => "native-uuid" },
      }),
    ).toBe("native-uuid")
  })

  test("uses getRandomValues when randomUUID is unavailable", () => {
    const crypto: UUIDCrypto = {
      getRandomValues(bytes) {
        for (let index = 0; index < bytes.length; index++) bytes[index] = index
        return bytes
      },
    }

    expect(generateUUID({ crypto })).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f")
  })

  test("falls back when randomUUID throws", () => {
    const crypto: UUIDCrypto = {
      randomUUID() {
        throw new DOMException("Blocked", "SecurityError")
      },
      getRandomValues(bytes) {
        bytes.fill(0xaa)
        return bytes
      },
    }

    expect(generateUUID({ crypto })).toBe("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa")
  })

  test("keeps fallback values unique without Web Crypto", () => {
    const environment = {
      crypto: undefined,
      now: () => 1_700_000_000_000,
      random: () => 0.5,
    }

    expect(generateUUID(environment)).not.toBe(generateUUID(environment))
  })
})
