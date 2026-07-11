import { describe, expect, test } from "bun:test"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"

describe("PluginManifest schema", () => {
  test("valid minimal manifest passes", () => {
    const result = PluginManifest.safeParse({
      name: "my-plugin",
      version: "1.0.0",
      description: "A test plugin",
    })
    expect(result.success).toBe(true)
  })

  test("invalid manifest fails on missing name", () => {
    const result = PluginManifest.safeParse({
      version: "1.0.0",
      description: "No name here",
    })
    expect(result.success).toBe(false)
  })

  test("invalid manifest fails on missing version", () => {
    const result = PluginManifest.safeParse({
      name: "my-plugin",
      description: "No version here",
    })
    expect(result.success).toBe(false)
  })

  test("invalid manifest fails on bad semver", () => {
    const result = PluginManifest.safeParse({
      name: "my-plugin",
      version: "not-semver",
      description: "Bad version",
    })
    expect(result.success).toBe(false)
  })

  test("invalid manifest fails on missing description", () => {
    const result = PluginManifest.safeParse({
      name: "my-plugin",
      version: "1.0.0",
    })
    expect(result.success).toBe(false)
  })

  test("invalid manifest fails on description too long", () => {
    const result = PluginManifest.safeParse({
      name: "my-plugin",
      version: "1.0.0",
      description: "a".repeat(1025),
    })
    expect(result.success).toBe(false)
  })

  test("valid full manifest with all optional fields passes", () => {
    const result = PluginManifest.safeParse({
      name: "full-plugin",
      version: "2.5.1-beta.1+build123",
      description: "A fully-loaded test plugin",
      author: "Test Author",
      homepage: "https://example.com",
      repository: "https://github.com/example/plugin",
      license: "MIT",
      icon: "https://example.com/icon.png",
      keywords: ["test", "plugin", "synergy"],
      engines: { synergy: ">=1.0.0", bun: ">=1.0.0" },
      dependencies: { "other-plugin": "~2.0.0" },
      contributes: {
        tools: [{ name: "my-tool", description: "Does things", kind: "utility" }],
        skills: [{ name: "my-skill", description: "A skill", dir: "./skills/my-skill" }],
        agents: [
          {
            name: "my-agent",
            description: "An agent",
            mode: "subagent" as const,
            model: "openai/gpt-4",
          },
        ],
        mcp: {
          myServer: {
            type: "local" as const,
            command: ["node", "server.js"],
            environment: { NODE_ENV: "production" },
            description: "My MCP server",
            timeout: 30000,
          },
        },
        commands: [{ name: "my-cmd", description: "A command" }],
        config: {
          schema: { foo: { type: "string" } },
          defaults: { foo: "bar" },
        },
      },
      main: "./src/index.ts",
      lifecycle: {
        install: "./scripts/install.ts",
        uninstall: "./scripts/uninstall.ts",
        update: "./scripts/update.ts",
      },
    })
    expect(result.success).toBe(true)
  })

  test("runtime field with mode and resources passes", () => {
    const result = PluginManifest.safeParse({
      name: "runtime-plugin",
      version: "1.0.0",
      description: "A plugin with runtime preferences",
      runtime: {
        mode: "process",
        minRuntimeApiVersion: "1.0.0",
        resources: {
          memoryMb: 512,
          startupTimeoutMs: 10000,
          toolInvocationTimeoutMs: 60000,
          bridgeRequestTimeoutMs: 60000,
          taskRunTimeoutMs: 60000,
          maxConcurrentRequests: 16,
          maxLogBytesPerMinute: 256000,
        },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.runtime?.mode).toBe("process")
      expect(result.data.runtime?.resources?.memoryMb).toBe(512)
      expect(result.data.runtime?.resources?.startupTimeoutMs).toBe(10000)
    }
  })

  test("runtime field omitted (backward compatible)", () => {
    const result = PluginManifest.safeParse({
      name: "old-plugin",
      version: "1.0.0",
      description: "No runtime field",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.runtime).toBeUndefined()
    }
  })

  test("runtime mode must be valid enum value", () => {
    const result = PluginManifest.safeParse({
      name: "bad-plugin",
      version: "1.0.0",
      description: "Invalid runtime mode",
      runtime: { mode: "thread" },
    })
    expect(result.success).toBe(false)
  })

  test("unknown extra fields are rejected (strict mode)", () => {
    const result = PluginManifest.safeParse({
      name: "my-plugin",
      version: "1.0.0",
      description: "A test plugin",
      unknownField: "should be rejected",
    })
    expect(result.success).toBe(false)
  })

  test("UI themes use structured JSON assets", () => {
    const valid = PluginManifest.safeParse({
      name: "theme-plugin",
      version: "1.0.0",
      description: "Contributes a complete visual theme",
      permissions: { ui: true },
      contributes: {
        ui: {
          themes: [{ id: "ocean", label: "Ocean", path: "./themes/ocean.json" }],
        },
      },
    })
    expect(valid.success).toBe(true)

    const cssAsset = PluginManifest.safeParse({
      name: "legacy-theme-plugin",
      version: "1.0.0",
      description: "Uses an unvalidated CSS theme",
      permissions: { ui: true },
      contributes: {
        ui: {
          themes: [{ id: "legacy", label: "Legacy", path: "./themes/legacy.css" }],
        },
      },
    })
    expect(cssAsset.success).toBe(false)
  })

  test("minSynergyVersion is rejected", () => {
    const result = PluginManifest.safeParse({
      name: "old-version-field-plugin",
      version: "1.0.0",
      description: "Uses the removed version contract field",
      minSynergyVersion: "1.0.0",
    })
    expect(result.success).toBe(false)
  })

  test("unknown tool permissions are rejected", () => {
    const result = PluginManifest.safeParse({
      name: "future-permission-plugin",
      version: "1.0.0",
      description: "Uses an unknown permission",
      permissions: {
        tools: {
          browser: true,
        },
      },
    })
    expect(result.success).toBe(false)
  })

  test("config hook permission parses and defaults to false", () => {
    const result = PluginManifest.safeParse({
      name: "config-hook-plugin",
      version: "1.0.0",
      description: "Observes config hook snapshots",
      permissions: {
        hooks: {
          config: true,
        },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.permissions?.hooks?.config).toBe(true)
    }

    const minimal = PluginManifest.parse({
      name: "minimal-plugin",
      version: "1.0.0",
      description: "No hook permission",
      permissions: {
        hooks: {},
      },
    })
    expect(minimal.permissions?.hooks?.config).toBe(false)
  })

  test("unknown hook permission fields are rejected", () => {
    const result = PluginManifest.safeParse({
      name: "future-hook-plugin",
      version: "1.0.0",
      description: "Uses an unknown hook permission",
      permissions: {
        hooks: {
          futureHook: true,
        },
      },
    })
    expect(result.success).toBe(false)
  })

  test("plugin-specific invoke permission is rejected", () => {
    const result = PluginManifest.safeParse({
      name: "invoke-permission-plugin",
      version: "1.0.0",
      description: "Uses removed plugin-specific invoke permission",
      permissions: {
        tools: {
          invoke: true,
        },
      },
    })
    expect(result.success).toBe(false)
  })
})

test('filesystem: true is migrated to "write" (backward compat)', () => {
  const result = PluginManifest.safeParse({
    name: "old-plugin",
    version: "1.0.0",
    description: "Uses legacy boolean filesystem",
    permissions: {
      tools: {
        filesystem: true,
      },
    },
  })
  expect(result.success).toBe(true)
  if (result.success) {
    expect(result.data.permissions?.tools?.filesystem).toBe("write")
  }
})

test('filesystem: false is migrated to "none" (backward compat)', () => {
  const result = PluginManifest.safeParse({
    name: "old-plugin",
    version: "1.0.0",
    description: "Uses legacy boolean filesystem",
    permissions: {
      tools: {
        filesystem: false,
      },
    },
  })
  expect(result.success).toBe(true)
  if (result.success) {
    expect(result.data.permissions?.tools?.filesystem).toBe("none")
  }
})

test('filesystem: "read" passes through unchanged', () => {
  const result = PluginManifest.safeParse({
    name: "new-plugin",
    version: "1.0.0",
    description: "Uses enum filesystem",
    permissions: {
      tools: {
        filesystem: "read",
      },
    },
  })
  expect(result.success).toBe(true)
  if (result.success) {
    expect(result.data.permissions?.tools?.filesystem).toBe("read")
  }
})

test('filesystem: "write" passes through unchanged', () => {
  const result = PluginManifest.safeParse({
    name: "new-plugin",
    version: "1.0.0",
    description: "Uses enum filesystem",
    permissions: {
      tools: {
        filesystem: "write",
      },
    },
  })
  expect(result.success).toBe(true)
  if (result.success) {
    expect(result.data.permissions?.tools?.filesystem).toBe("write")
  }
})
