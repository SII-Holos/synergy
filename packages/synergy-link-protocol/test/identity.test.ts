import { describe, expect, test } from "bun:test"
import { SynergyLinkIdentity } from "../src/identity"

describe("synergy-link identity resolution", () => {
  test("omitted and blank inputs resolve to intentional local execution", () => {
    expect(SynergyLinkIdentity.resolve(undefined)).toEqual({ kind: "local", reason: "omitted" })
    expect(SynergyLinkIdentity.resolve("   ")).toEqual({ kind: "local", reason: "blank" })
    expect(SynergyLinkIdentity.resolve("\t\n")).toEqual({ kind: "local", reason: "blank" })
  })

  test("placeholder aliases and retired env_ prefixes are rejected as placeholders", () => {
    for (const alias of ["env", "/", "/omit", "undefined", "null", "none", "nil", "n/a", "env_legacy"]) {
      expect(SynergyLinkIdentity.resolve(alias)).toEqual({
        kind: "invalid",
        input: alias,
        reason: "placeholder_alias",
      })
    }
    expect(SynergyLinkIdentity.resolve("  env  ")).toEqual({
      kind: "invalid",
      input: "env",
      reason: "placeholder_alias",
    })
  })

  test("local aliases are rejected with a hint to omit linkID", () => {
    for (const alias of [
      "local",
      ":local",
      "localhost",
      "127.0.0.1",
      "::1",
      "loopback",
      "self",
      ":self",
      "current",
      ":current",
      "host",
      ":host",
      "this",
      ":this",
    ]) {
      expect(SynergyLinkIdentity.resolve(alias)).toEqual({
        kind: "invalid",
        input: alias,
        reason: "local_alias",
      })
    }
  })

  test("remote link IDs are trimmed and require the lowercase link_ prefix", () => {
    expect(SynergyLinkIdentity.resolve(" link_abc123 ")).toEqual({ kind: "remote", linkID: "link_abc123" })
    expect(SynergyLinkIdentity.resolve("link_")).toEqual({ kind: "remote", linkID: "link_" })
    expect(SynergyLinkIdentity.resolve("Link_ABC")).toEqual({
      kind: "invalid",
      input: "Link_ABC",
      reason: "invalid_format",
    })
  })

  test("plain identifiers without the link_ prefix are invalid", () => {
    expect(SynergyLinkIdentity.resolve("abc")).toEqual({ kind: "invalid", input: "abc", reason: "invalid_format" })
    expect(SynergyLinkIdentity.resolve("link")).toEqual({
      kind: "invalid",
      input: "link",
      reason: "invalid_format",
    })
  })

  test("requireLinkID returns remote IDs and throws structured errors otherwise", () => {
    expect(SynergyLinkIdentity.requireLinkID("link_target")).toBe("link_target")

    expect(() => SynergyLinkIdentity.requireLinkID("local")).toThrow(SynergyLinkIdentity.InvalidLinkIDError)
    try {
      SynergyLinkIdentity.requireLinkID("local")
    } catch (error) {
      expect(error).toBeInstanceOf(SynergyLinkIdentity.InvalidLinkIDError)
      expect(error).toBeInstanceOf(Error)
      expect((error as SynergyLinkIdentity.InvalidLinkIDError).name).toBe("SynergyLinkInvalidLinkIDError")
      expect((error as SynergyLinkIdentity.InvalidLinkIDError).linkID).toBe("local")
      expect((error as SynergyLinkIdentity.InvalidLinkIDError).reason).toBe("local_alias")
      expect((error as Error).message).toContain("Omit linkID for intentional local execution")
    }

    expect(() => SynergyLinkIdentity.requireLinkID(undefined)).toThrow(/Missing linkID/)
    try {
      SynergyLinkIdentity.requireLinkID(undefined)
    } catch (error) {
      expect((error as SynergyLinkIdentity.InvalidLinkIDError).reason).toBe("missing")
    }
  })

  test("invalid format and placeholder errors carry their reasons", () => {
    try {
      SynergyLinkIdentity.requireLinkID("abc")
    } catch (error) {
      expect((error as SynergyLinkIdentity.InvalidLinkIDError).reason).toBe("invalid_format")
      expect((error as Error).message).toContain('must start with "link_"')
    }
    try {
      SynergyLinkIdentity.requireLinkID("env")
    } catch (error) {
      expect((error as SynergyLinkIdentity.InvalidLinkIDError).reason).toBe("placeholder_alias")
      expect((error as Error).message).toContain("placeholder or retired target ID")
    }
  })
})

describe("synergy-link identity schemas", () => {
  test("LinkID requires the link_ prefix", () => {
    expect(SynergyLinkIdentity.LinkID.parse("link_host")).toBe("link_host")
    expect(() => SynergyLinkIdentity.LinkID.parse("host")).toThrow()
    expect(() => SynergyLinkIdentity.LinkID.parse("")).toThrow()
  })

  test("session and process identifiers must not be empty", () => {
    expect(SynergyLinkIdentity.SessionID.parse("session_1")).toBe("session_1")
    expect(SynergyLinkIdentity.ProcessID.parse("proc_1")).toBe("proc_1")
    expect(SynergyLinkIdentity.HostSessionID.parse("host_1")).toBe("host_1")
    expect(() => SynergyLinkIdentity.SessionID.parse("")).toThrow()
    expect(() => SynergyLinkIdentity.ProcessID.parse("")).toThrow()
    expect(() => SynergyLinkIdentity.HostSessionID.parse("")).toThrow()
  })

  test("warnings validate their shape and reject unknown codes", () => {
    expect(
      SynergyLinkIdentity.Warning.parse({
        code: "synergy_link.not_connected",
        message: "not connected",
        reminder: "run synergy-link connect",
        requestedLinkID: "link_other",
        retryable: true,
      }),
    ).toEqual({
      code: "synergy_link.not_connected",
      message: "not connected",
      reminder: "run synergy-link connect",
      requestedLinkID: "link_other",
      retryable: true,
    })
    expect(
      SynergyLinkIdentity.Warning.parse({
        code: "synergy_link.invalid_link_id",
        message: "bad",
        reminder: "fix it",
        retryable: false,
      }),
    ).toEqual({ code: "synergy_link.invalid_link_id", message: "bad", reminder: "fix it", retryable: false })
    expect(() =>
      SynergyLinkIdentity.Warning.parse({ code: "other", message: "x", reminder: "y", retryable: true }),
    ).toThrow()
  })
})
