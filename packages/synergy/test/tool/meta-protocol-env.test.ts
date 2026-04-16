import { describe, expect, test } from "bun:test"
import { MetaProtocolEnv } from "@ericsanchezok/meta-protocol"

describe("meta protocol env", () => {
  test("treats local aliases as local", () => {
    const aliases = [
      undefined,
      "",
      "   ",
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
    ]

    for (const value of aliases) {
      expect(MetaProtocolEnv.resolve(value)).toEqual({ kind: "local" })
    }
  })

  test("normalizes remote env IDs by trimming whitespace", () => {
    expect(MetaProtocolEnv.normalize("  env_test  ")).toBe("env_test")
    expect(MetaProtocolEnv.resolve("  env_test  ")).toEqual({ kind: "remote", envID: "env_test" })
  })

  test("rejects placeholder env IDs with a guided error", () => {
    expect(() => MetaProtocolEnv.resolve("undefined")).toThrow(
      'Invalid envID "undefined". This looks like a placeholder value, not a real remote environment ID.',
    )
    expect(() => MetaProtocolEnv.normalize("null")).toThrow("do NOT include the envID parameter at all")
  })

  test("rejects env IDs that do not start with env_ prefix", () => {
    const invalidValues = ["/omit", ":bad", ":(", ":REMOVE", "env_fake".slice(0, 3), "random_string", "/willfail"]

    for (const value of invalidValues) {
      expect(() => MetaProtocolEnv.normalize(value)).toThrow(MetaProtocolEnv.InvalidEnvIDError)
      expect(() => MetaProtocolEnv.normalize(value)).toThrow('must start with "env_"')
    }
  })

  test("accepts valid env_ prefixed IDs", () => {
    expect(MetaProtocolEnv.normalize("env_abc123")).toBe("env_abc123")
    expect(MetaProtocolEnv.normalize("env_test")).toBe("env_test")
    expect(MetaProtocolEnv.resolve("env_test")).toEqual({ kind: "remote", envID: "env_test" })
  })
})
