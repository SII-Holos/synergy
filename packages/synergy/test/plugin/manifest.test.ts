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
      minSynergyVersion: "1.0.0",
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
        extensionPack: ["ext-a", "ext-b"],
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

  test("unknown extra fields are rejected (strict mode)", () => {
    const result = PluginManifest.safeParse({
      name: "my-plugin",
      version: "1.0.0",
      description: "A test plugin",
      unknownField: "should be rejected",
    })
    expect(result.success).toBe(false)
  })
})
