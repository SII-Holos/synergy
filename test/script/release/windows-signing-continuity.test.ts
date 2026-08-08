import { describe, expect, test } from "bun:test"
import {
  assertWindowsSigningContinuity,
  hasAuthenticodeSignature,
} from "../../../script/release/assert-windows-signing-continuity"

function pePrefixWithCertificateTable(certificateTableSize: number): Uint8Array {
  const buffer = new Uint8Array(0x140)
  buffer[0] = 0x4d
  buffer[1] = 0x5a
  const view = new DataView(buffer.buffer)
  const eLfanew = 0x80
  view.setUint32(0x3c, eLfanew, true)
  buffer[eLfanew] = 0x50
  buffer[eLfanew + 1] = 0x45
  const coffEnd = eLfanew + 0x18
  view.setUint16(coffEnd, 0x20b, true)
  const dataDirectoryBase = coffEnd + 112
  const certificateTableOffset = dataDirectoryBase + 4 * 8
  view.setUint32(certificateTableOffset + 4, certificateTableSize, true)
  return buffer
}

describe("Authenticode signature detection", () => {
  test("detects a certificate table in a PE32+ prefix", () => {
    expect(hasAuthenticodeSignature(pePrefixWithCertificateTable(0x100))).toBe(true)
  })

  test("reports unsigned when the certificate table size is zero", () => {
    expect(hasAuthenticodeSignature(pePrefixWithCertificateTable(0))).toBe(false)
  })

  test("rejects non-PE prefixes", () => {
    expect(hasAuthenticodeSignature(new TextEncoder().encode("hello world"))).toBe(false)
  })

  test("rejects truncated prefixes", () => {
    expect(hasAuthenticodeSignature(new Uint8Array(8))).toBe(false)
  })
})

describe("Windows signing continuity", () => {
  test("skips the history check when signing material is configured", async () => {
    let called = false
    await assertWindowsSigningContinuity(
      { WINDOWS_CERTIFICATE: "certificate" },
      {
        previousWindowsInstallerWasSigned: async () => {
          called = true
          return true
        },
      },
    )
    expect(called).toBe(false)
  })

  test("rejects an unsigned release after a signed installer was published", async () => {
    await expect(
      assertWindowsSigningContinuity(
        {},
        {
          previousWindowsInstallerWasSigned: async () => true,
        },
      ),
    ).rejects.toThrow(/previously published Windows release is code-signed/)
  })

  test("allows an unsigned release when no previous installer was signed", async () => {
    await expect(
      assertWindowsSigningContinuity(
        {},
        {
          previousWindowsInstallerWasSigned: async () => false,
        },
      ),
    ).resolves.toBeUndefined()
  })
})
