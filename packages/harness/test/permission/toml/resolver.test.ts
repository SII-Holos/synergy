import { test, expect } from "bun:test"
import { TomlResolver } from "../../../src/permission/toml/resolver"
import {
  UndefinedProfileError,
  UndefinedParentError,
  UnsupportedBuiltinParentError,
} from "../../../src/permission/toml/resolver"

function emptyProfile() {
  return {
    description: "base",
    filesystem: {
      read: ["/base"],
      write: ["/base"],
      deny: [],
    },
    network: {
      enabled: true,
      mode: "full" as const,
      domains: ["base.com"],
    },
  }
}

test("resolves profile without extends as identity", () => {
  const input = {
    description: "standalone",
    filesystem: {
      read: ["/app"],
      write: ["/app"],
      deny: [],
    },
    network: {
      enabled: false,
      mode: "restricted" as const,
      domains: [],
    },
  }
  const result = TomlResolver.resolve(input, {})
  expect(result.description).toBe("standalone")
  expect(result.filesystem.read).toEqual(["/app"])
  expect(result.filesystem.write).toEqual(["/app"])
  expect(result.network.enabled).toBe(false)
})

test("resolves single-level inheritance (child overrides parent)", () => {
  const parent = {
    description: "parent",
    filesystem: {
      read: ["/parent"],
      write: ["/parent"],
      deny: [],
    },
    network: {
      enabled: true,
      mode: "full" as const,
      domains: ["parent.com"],
    },
  }
  const child = {
    extends: "parent",
    description: "child",
    network: {
      enabled: false,
    },
  }
  const profiles = { parent }
  const result = TomlResolver.resolve(child, profiles)
  expect(result.description).toBe("child")
  expect(result.filesystem.read).toEqual(["/parent"])
  expect(result.network.enabled).toBe(false)
  // inherited scalar not overridden by child
  expect(result.network.mode).toBe("full")
})

test("resolves multi-level chain (A → B → C)", () => {
  const a = {
    description: "A",
    filesystem: { read: ["/a"], write: ["/a"], deny: [] },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const b = {
    extends: "A",
    description: "B",
    filesystem: { read: ["/b"], write: [], deny: [] },
  }
  const c = {
    extends: "B",
    description: "C",
    network: { enabled: false },
  }
  const profiles = { A: a, B: b, C: c }
  const result = TomlResolver.resolve(c, profiles)
  // C overrides description and network.enabled
  expect(result.description).toBe("C")
  expect(result.network.enabled).toBe(false)
  // C didn't override filesystem.read → inherits from B
  expect(result.filesystem.read).toEqual(["/b"])
  // B had no network mode → inherits from A
  expect(result.network.mode).toBe("full")
})

test("child filesystem keys override parent", () => {
  const parent = {
    filesystem: {
      read: ["/parent"],
      write: ["/parent"],
      deny: ["/parent/secrets"],
    },
    network: { enabled: true, mode: "restricted" as const, domains: [] },
  }
  const child = {
    extends: "parent",
    filesystem: {
      read: ["/child"],
    },
  }
  const profiles = { parent }
  const result = TomlResolver.resolve(child, profiles)
  // child.read replaces parent.read completely
  expect(result.filesystem.read).toEqual(["/child"])
  // parent keys not specified in child are inherited
  expect(result.filesystem.write).toEqual(["/parent"])
  expect(result.filesystem.deny).toEqual(["/parent/secrets"])
})

test("child network scalars override parent", () => {
  const parent = {
    filesystem: { read: ["/"], write: [], deny: [] },
    network: {
      enabled: false,
      mode: "restricted" as const,
      domains: ["parent.com"],
    },
  }
  const child = {
    extends: "parent",
    network: {
      enabled: true,
      mode: "full" as const,
    },
  }
  const profiles = { parent }
  const result = TomlResolver.resolve(child, profiles)
  expect(result.network.enabled).toBe(true)
  expect(result.network.mode).toBe("full")
  // domains not specified in child → inherited from parent
  expect(result.network.domains).toEqual(["parent.com"])
})

test("network domains are normalized (lowercased) during merge", () => {
  const parent = {
    filesystem: { read: ["/"], write: [], deny: [] },
    network: {
      domains: ["PARENT.com"],
    },
  }
  const child = {
    extends: "parent",
    network: {
      domains: ["Child.ORG"],
    },
  }
  const profiles = { parent }
  const result = TomlResolver.resolve(child, profiles)
  expect(result.network.domains).toEqual(["child.org"])
})

test("parent description is not leaked into child", () => {
  const parent = {
    description: "I am parent",
    filesystem: { read: ["/"], write: [], deny: [] },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const child = {
    extends: "parent",
    description: "I am child",
  }
  const profiles = { parent }
  const result = TomlResolver.resolve(child, profiles)
  expect(result.description).toBe("I am child")
})

test("detects direct cycle (A extends A)", () => {
  const a = {
    extends: "A",
    filesystem: { read: ["/a"], write: [], deny: [] },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const profiles = { A: a }
  expect(() => TomlResolver.resolve(a, profiles)).toThrow()
})

test("detects indirect cycle (A extends B extends C extends A)", () => {
  const a = {
    extends: "B",
    filesystem: { read: ["/a"], write: [], deny: [] },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const b = {
    extends: "C",
    filesystem: { read: ["/b"], write: [], deny: [] },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const c = {
    extends: "A",
    filesystem: { read: ["/c"], write: [], deny: [] },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const profiles = { A: a, B: b, C: c }
  expect(() => TomlResolver.resolve(a, profiles)).toThrow()
})

test("throws UndefinedProfileError for missing profile", () => {
  expect(() => TomlResolver.get("nonexistent", {})).toThrow(UndefinedProfileError)
})

test("throws UndefinedParentError for missing parent", () => {
  const child = {
    extends: "nonexistent_parent",
    filesystem: { read: ["/"], write: [], deny: [] },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const profiles = {}
  expect(() => TomlResolver.resolve(child, profiles)).toThrow(UndefinedParentError)
})

test("throws UnsupportedBuiltinParentError for unknown :prefix parent", () => {
  const child = {
    extends: ":made_up_builtin",
    filesystem: { read: ["/"], write: [], deny: [] },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const profiles = {}
  expect(() => TomlResolver.resolve(child, profiles)).toThrow(UnsupportedBuiltinParentError)
})

test("workspace_roots: child replaces parent entirely", () => {
  const parent = {
    filesystem: { read: ["/parent"], write: [], deny: [] },
    network: { enabled: true, mode: "full" as const, domains: [] },
    workspace_roots: ["/workspace-a"],
  }
  const child = {
    extends: "parent",
    workspace_roots: ["/workspace-b", "/workspace-c"],
  }
  const profiles = { parent }
  const result = TomlResolver.resolve(child, profiles)
  expect(result.workspace_roots).toEqual(["/workspace-b", "/workspace-c"])
})
