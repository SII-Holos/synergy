import { describe, expect, test } from "bun:test"
import { Email } from "../../src/email/service"

describe("transportIdentityKey", () => {
  test("excludes the password from the cache key", () => {
    const key = Email.transportIdentityKey({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      username: "agent@example.com",
      password: "super-secret-token",
    })
    expect(key).not.toContain("super-secret-token")
    expect(key).toContain("smtp.example.com")
  })

  test("password rotation yields a different key so the pooled transport is rebuilt", () => {
    const base = {
      host: "smtp.example.com",
      port: 465,
      secure: true,
      username: "agent@example.com",
    }
    const keyA = Email.transportIdentityKey({ ...base, password: "secret-a" })
    const keyB = Email.transportIdentityKey({ ...base, password: "secret-b" })
    expect(keyA).not.toBe(keyB)
  })

  test("key contains no plaintext password, only a fingerprint", () => {
    const key = Email.transportIdentityKey({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      username: "agent@example.com",
      password: "super-secret-token",
    })
    expect(key).not.toContain("super-secret-token")
    expect(key).toContain("passwordFingerprint")
  })

  test("different identity fields produce different keys", () => {
    const base = {
      host: "smtp.example.com",
      port: 465,
      secure: true,
      username: "agent@example.com",
      password: "secret",
    }
    const other = Email.transportIdentityKey({ ...base, host: "smtp.other.com" })
    expect(other).not.toBe(Email.transportIdentityKey(base))
  })
})
