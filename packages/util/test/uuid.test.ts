import { describe, expect, test } from "bun:test"
import {
  generateRandomBytes,
  generateSecureRandomBytes,
  generateSecureUUID,
  generateUUID,
  SecureRandomUnavailableError,
  type UUIDCrypto,
} from "../src/uuid"

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

describe("generateRandomBytes", () => {
  test("uses Web Crypto when available", () => {
    const crypto: UUIDCrypto = {
      getRandomValues(bytes) {
        bytes.fill(0xab)
        return bytes
      },
    }

    expect(generateRandomBytes(4, { crypto })).toEqual(new Uint8Array([0xab, 0xab, 0xab, 0xab]))
  })

  test("allows a deterministic weak fallback for ordinary identifiers", () => {
    expect(generateRandomBytes(3, { crypto: undefined, random: () => 0.5 })).toEqual(new Uint8Array([128, 128, 128]))
  })
})

describe("secure UUID generation", () => {
  test("uses native randomUUID when available", () => {
    expect(generateSecureUUID({ crypto: { randomUUID: () => "secure-native" } })).toBe("secure-native")
  })

  test("uses getRandomValues without a weak fallback", () => {
    const crypto: UUIDCrypto = {
      getRandomValues(bytes) {
        bytes.fill(0xcd)
        return bytes
      },
    }

    expect(generateSecureUUID({ crypto })).toBe("cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd")
    expect(generateSecureRandomBytes(3, { crypto })).toEqual(new Uint8Array([0xcd, 0xcd, 0xcd]))
  })

  test("fails the affected operation when Web Crypto is unavailable", () => {
    expect(() => generateSecureUUID({ crypto: undefined, random: () => 0.5 })).toThrow(SecureRandomUnavailableError)
    expect(() => generateSecureRandomBytes(16, { crypto: undefined, random: () => 0.5 })).toThrow(
      SecureRandomUnavailableError,
    )
  })

  test("fails when getRandomValues is exposed but unusable", () => {
    expect(() =>
      generateSecureRandomBytes(16, {
        crypto: {
          getRandomValues() {
            throw new DOMException("Blocked", "SecurityError")
          },
        },
      }),
    ).toThrow(SecureRandomUnavailableError)
  })
})
