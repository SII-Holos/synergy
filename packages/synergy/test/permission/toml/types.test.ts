import { test, expect } from "bun:test"
import { TomlProfile } from "../../../src/permission/toml/types"

test("Zod schema validates complete TOML object", () => {
  const valid = {
    description: "Test profile",
    extends: ":workspace",
    filesystem: {
      read: ["/workspace", "/tmp/build"],
      write: ["/workspace/output"],
      deny: ["/workspace/secrets", "/etc/**"],
    },
    network: {
      enabled: true,
      mode: "full",
      domains: ["Example.com"],
    },
    workspace_roots: ["/workspace"],
  }
  const result = TomlProfile.safeParse(valid)
  expect(result.success).toBe(true)
})

test("rejects invalid access mode", () => {
  // filesystem keys must be one of: read, write, deny
  const invalid = {
    filesystem: {
      read: ["/workspace"],
      execute: ["/bad"],
    },
  }
  const result = TomlProfile.safeParse(invalid)
  expect(result.success).toBe(false)
})

test("rejects invalid network mode", () => {
  const invalid = {
    network: {
      mode: "super_fast",
    },
  }
  const result = TomlProfile.safeParse(invalid)
  expect(result.success).toBe(false)
})
