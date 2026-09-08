import { test, expect } from "bun:test"
import { TomlCompiler } from "../../../src/permission/toml/compiler"

test('"read" path → readableRoots', () => {
  const profile = {
    filesystem: {
      read: ["/workspace", "/tmp/build"],
      write: [],
      deny: [],
    },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const result = TomlCompiler.compile(profile, { workspace: "/workspace" })
  expect(result.fileSystem.readableRoots).toContain("/workspace")
  expect(result.fileSystem.readableRoots).toContain("/tmp/build")
})

test('"write" path → writableRoots (only in workspace_write mode)', () => {
  const profile = {
    filesystem: {
      read: ["/workspace"],
      write: ["/workspace/output"],
      deny: [],
    },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const result = TomlCompiler.compile(profile, {
    workspace: "/workspace",
    sandboxMode: "workspace_write",
  })
  expect(result.fileSystem.writableRoots).toContain("/workspace/output")
})

test('"deny" exact path → dataDenyRoots', () => {
  const profile = {
    filesystem: {
      read: ["/workspace"],
      write: [],
      deny: ["/workspace/secrets"],
    },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const result = TomlCompiler.compile(profile, { workspace: "/workspace" })
  expect(result.fileSystem.dataDenyRoots).toContain("/workspace/secrets")
})

test('"deny" glob → unreadableGlobs', () => {
  const profile = {
    filesystem: {
      read: ["/workspace"],
      write: [],
      deny: ["/workspace/**/*.key"],
    },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const result = TomlCompiler.compile(profile, { workspace: "/workspace" })
  expect(result.fileSystem.unreadableGlobs.length).toBeGreaterThan(0)
  expect(result.fileSystem.unreadableGlobs).toContain("/workspace/**/*.key")
})

test('":workspace_roots" special path → workspace', () => {
  const profile = {
    filesystem: {
      read: [":workspace_roots"],
      write: [],
      deny: [],
    },
    network: { enabled: true, mode: "full" as const, domains: [] },
    workspace_roots: ["/primary", "/secondary"],
  }
  const result = TomlCompiler.compile(profile, { workspace: "/somewhere" })
  expect(result.fileSystem.readableRoots).toContain("/primary")
  expect(result.fileSystem.readableRoots).toContain("/secondary")
  // :workspace_roots resolves to each workspace_roots entry, not the literal prefix
  expect(result.fileSystem.readableRoots).not.toContain(":workspace_roots")
})

test('":tmpdir" → tmpdir', () => {
  const profile = {
    filesystem: {
      read: [":tmpdir"],
      write: [],
      deny: [],
    },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const result = TomlCompiler.compile(profile, { workspace: "/workspace" })
  // tmpdir should resolve to the actual OS temp directory path
  const tmpRoot = result.fileSystem.readableRoots.find((r: string) => r !== "/workspace")
  expect(tmpRoot).toBeDefined()
  expect(tmpRoot!.length).toBeGreaterThan(0)
  expect(tmpRoot).not.toBe("/workspace")
})

test('":root" → "/"', () => {
  const profile = {
    filesystem: {
      read: [":root"],
      write: [],
      deny: [],
    },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const result = TomlCompiler.compile(profile, { workspace: "/workspace" })
  expect(result.fileSystem.readableRoots).toContain("/")
})

test('unknown ":*" → warn-and-ignore', () => {
  const profile = {
    filesystem: {
      read: [":made_up_thing"],
      write: [],
      deny: [],
    },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  // Should not throw — unknown special paths are logged and skipped
  const result = TomlCompiler.compile(profile, { workspace: "/workspace" })
  expect(result.fileSystem.readableRoots).not.toContain(":made_up_thing")
})

test("network enabled=true → mode full", () => {
  const profile = {
    filesystem: { read: ["/"], write: [], deny: [] },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const result = TomlCompiler.compile(profile, { workspace: "/" })
  expect(result.network.mode).toBe("full")
})

test('network mode "limited" → "restricted"', () => {
  const profile = {
    filesystem: { read: ["/"], write: [], deny: [] },
    network: { enabled: true, mode: "limited" as any, domains: ["allowed.com"] },
  }
  const result = TomlCompiler.compile(profile, { workspace: "/" })
  expect(result.network.mode).toBe("restricted")
  expect((result.network as any).allowedDomains).toContain("allowed.com")
})

test("protected paths under writable roots become readOnlySubpaths", () => {
  const profile = {
    filesystem: {
      read: ["/workspace"],
      write: ["/workspace"],
      deny: ["/workspace/.git"],
    },
    network: { enabled: true, mode: "full" as const, domains: [] },
  }
  const result = TomlCompiler.compile(profile, {
    workspace: "/workspace",
    sandboxMode: "workspace_write",
  })
  // /workspace/.git is under a writable root → becomes readOnlySubpaths
  expect(result.fileSystem.readOnlySubpaths).toContain("/workspace/.git")
})

test("non-overlapping read/write/deny produce clean compiled result", () => {
  const profile = {
    filesystem: {
      read: ["/workspace", "/usr/share"],
      write: ["/workspace/build"],
      deny: ["/etc", "/workspace/.git/**"],
    },
    network: {
      enabled: true,
      mode: "limited" as any,
      domains: ["api.example.com", "GitHub.com"],
    },
  }
  const result = TomlCompiler.compile(profile, {
    workspace: "/workspace",
    sandboxMode: "workspace_write",
  })
  // Readable roots include read paths
  expect(result.fileSystem.readableRoots).toContain("/workspace")
  expect(result.fileSystem.readableRoots).toContain("/usr/share")
  // Writable roots
  expect(result.fileSystem.writableRoots).toContain("/workspace/build")
  // Deny globs
  expect(result.fileSystem.unreadableGlobs).toContain("/workspace/.git/**")
  // Deny exact
  expect(result.fileSystem.dataDenyRoots).toContain("/etc")
  // Read-only subpaths: .git/** under writable workspace
  expect(result.fileSystem.readOnlySubpaths).toContain("/workspace/.git/**")
  // Network
  expect(result.network.mode).toBe("restricted")
  // Domains normalized (lowercased)
  expect((result.network as any).allowedDomains).toEqual(expect.arrayContaining(["api.example.com", "github.com"]))
})
