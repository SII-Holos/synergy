import { test, expect, mock, afterEach } from "bun:test"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/scope/instance"
import { Scope } from "../../src/scope"
import { Auth } from "../../src/provider/api-key"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { parse as parseJsonc } from "jsonc-parser"

test("loads config with defaults when no files exist", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.username).toBeDefined()
    },
  })
})

test("loads JSON config file", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          model: "test/model",
          username: "testuser",
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("test/model")
      expect(config.username).toBe("testuser")
    },
  })
})

test("loads JSONC config file", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.jsonc"),
        `{
        // This is a comment
        "$schema": "file:///test/config.schema.json",
        "model": "test/model",
        "username": "testuser"
      }`,
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("test/model")
      expect(config.username).toBe("testuser")
    },
  })
})

test("merges multiple config files with correct precedence", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.jsonc"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          model: "base",
          username: "base",
        }),
      )
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          model: "override",
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("override")
      expect(config.username).toBe("base")
    },
  })
})

test("handles environment variable substitution", async () => {
  const originalEnv = process.env["TEST_VAR"]
  process.env["TEST_VAR"] = "test_theme"

  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "synergy.json"),
          JSON.stringify({
            $schema: "file:///test/config.schema.json",
            theme: "{env:TEST_VAR}",
          }),
        )
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const config = await Config.get()
        expect(config.theme).toBe("test_theme")
      },
    })
  } finally {
    if (originalEnv !== undefined) {
      process.env["TEST_VAR"] = originalEnv
    } else {
      delete process.env["TEST_VAR"]
    }
  }
})

test("handles file inclusion substitution", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "included.txt"), "test_theme")
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          theme: "{file:included.txt}",
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.theme).toBe("test_theme")
    },
  })
})

test("validates config schema and throws on invalid fields", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          invalid_field: "should cause error",
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      // Strict schema should throw an error for invalid fields
      await expect(Config.get()).rejects.toThrow()
    },
  })
})

test("throws error for invalid JSON", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "synergy.json"), "{ invalid json }")
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await expect(Config.get()).rejects.toThrow()
    },
  })
})

test("handles agent configuration", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          agent: {
            test_agent: {
              model: "test/model",
              temperature: 0.7,
              description: "test agent",
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test_agent"]).toEqual(
        expect.objectContaining({
          model: "test/model",
          temperature: 0.7,
          description: "test agent",
        }),
      )
    },
  })
})

test("handles command configuration", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          command: {
            test_command: {
              template: "test template",
              description: "test command",
              agent: "test_agent",
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.command?.["test_command"]).toEqual({
        template: "test template",
        description: "test command",
        agent: "test_agent",
      })
    },
  })
})

test("loads config from .synergy directory", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const synergyDir = path.join(dir, ".synergy")
      await fs.mkdir(synergyDir, { recursive: true })
      const agentDir = path.join(synergyDir, "agent")
      await fs.mkdir(agentDir, { recursive: true })

      await Bun.write(
        path.join(agentDir, "test.md"),
        `---
model: test/model
---
Test agent prompt`,
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]).toEqual(
        expect.objectContaining({
          name: "test",
          model: "test/model",
          prompt: "Test agent prompt",
        }),
      )
    },
  })
})

test("updates config and writes to file", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const newConfig = { model: "updated/model" }
      await Config.update(newConfig as any)

      const filepath = path.join(tmp.path, ".synergy", "synergy.jsonc")
      const writtenConfig = parseJsonc(await Bun.file(filepath).text(), [], { allowTrailingComma: true }) as any
      expect(writtenConfig.model).toBe("updated/model")
    },
  })
})

test("gets config directories", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const dirs = await Config.directories()
      expect(dirs.length).toBeGreaterThanOrEqual(1)
    },
  })
})

test("resolves scoped npm plugins in config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const pluginDir = path.join(dir, "node_modules", "@scope", "plugin")
      await fs.mkdir(pluginDir, { recursive: true })

      await Bun.write(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "config-fixture", version: "1.0.0", type: "module" }, null, 2),
      )

      await Bun.write(
        path.join(pluginDir, "package.json"),
        JSON.stringify(
          {
            name: "@scope/plugin",
            version: "1.0.0",
            type: "module",
            main: "./index.js",
          },
          null,
          2,
        ),
      )

      await Bun.write(path.join(pluginDir, "index.js"), "export default {}\n")

      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify(
          {
            $schema: "file:///test/config.schema.json",
            plugin: ["@scope/plugin"],
          },
          null,
          2,
        ),
      )
    },
  })

  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      const pluginEntries = config.plugin ?? []

      const baseUrl = pathToFileURL(path.join(tmp.path, "synergy.json")).href
      const expected = import.meta.resolve("@scope/plugin", baseUrl)

      expect(pluginEntries.includes(expected)).toBe(true)

      const scopedEntry = pluginEntries.find((entry) => entry === expected)
      expect(scopedEntry).toBeDefined()
      expect(scopedEntry?.includes("/node_modules/@scope/plugin/")).toBe(true)
    },
  })
})

test("merges plugin arrays from global and local configs", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const synergyDir = path.join(dir, ".synergy")
      await fs.mkdir(synergyDir, { recursive: true })

      // Root config with plugins
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          plugin: ["global-plugin-1", "global-plugin-2"],
        }),
      )

      // .synergy config with different plugins
      await Bun.write(
        path.join(synergyDir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          plugin: ["local-plugin-1"],
        }),
      )
    },
  })

  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      const plugins = config.plugin ?? []

      // Should contain both root and .synergy plugins
      expect(plugins.some((p) => p.includes("global-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("global-plugin-2"))).toBe(true)
      expect(plugins.some((p) => p.includes("local-plugin-1"))).toBe(true)

      // Should have all 3 plugins (not replaced, but merged)
      const pluginNames = plugins.filter((p) => p.includes("global-plugin") || p.includes("local-plugin"))
      expect(pluginNames.length).toBeGreaterThanOrEqual(3)
    },
  })
})

test("does not error when only custom agent is a subagent", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const synergyDir = path.join(dir, ".synergy")
      await fs.mkdir(synergyDir, { recursive: true })
      const agentDir = path.join(synergyDir, "agent")
      await fs.mkdir(agentDir, { recursive: true })

      await Bun.write(
        path.join(agentDir, "helper.md"),
        `---
model: test/model
mode: subagent
---
Helper subagent prompt`,
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["helper"]).toMatchObject({
        name: "helper",
        model: "test/model",
        mode: "subagent",
        prompt: "Helper subagent prompt",
      })
    },
  })
})

test("merges instructions arrays from global and local configs", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const synergyDir = path.join(dir, ".synergy")
      await fs.mkdir(synergyDir, { recursive: true })

      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          instructions: ["global-instructions.md", "shared-rules.md"],
        }),
      )

      await Bun.write(
        path.join(synergyDir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          instructions: ["local-instructions.md"],
        }),
      )
    },
  })

  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      const instructions = config.instructions ?? []

      expect(instructions).toContain("global-instructions.md")
      expect(instructions).toContain("shared-rules.md")
      expect(instructions).toContain("local-instructions.md")
      expect(instructions.length).toBe(3)
    },
  })
})

test("deduplicates duplicate instructions from global and local configs", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const synergyDir = path.join(dir, ".synergy")
      await fs.mkdir(synergyDir, { recursive: true })

      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          instructions: ["duplicate.md", "global-only.md"],
        }),
      )

      await Bun.write(
        path.join(synergyDir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          instructions: ["duplicate.md", "local-only.md"],
        }),
      )
    },
  })

  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      const instructions = config.instructions ?? []

      expect(instructions).toContain("global-only.md")
      expect(instructions).toContain("local-only.md")
      expect(instructions).toContain("duplicate.md")

      const duplicates = instructions.filter((i) => i === "duplicate.md")
      expect(duplicates.length).toBe(1)
      expect(instructions.length).toBe(3)
    },
  })
})

test("deduplicates duplicate plugins from global and local configs", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const synergyDir = path.join(dir, ".synergy")
      await fs.mkdir(synergyDir, { recursive: true })

      // Root config with plugins
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          plugin: ["duplicate-plugin", "global-plugin-1"],
        }),
      )

      // .synergy config with some overlapping plugins
      await Bun.write(
        path.join(synergyDir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          plugin: ["duplicate-plugin", "local-plugin-1"],
        }),
      )
    },
  })

  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      const plugins = config.plugin ?? []

      // Should contain all unique plugins
      expect(plugins.some((p) => p.includes("global-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("local-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("duplicate-plugin"))).toBe(true)

      // Should deduplicate the duplicate plugin
      const duplicatePlugins = plugins.filter((p) => p.includes("duplicate-plugin"))
      expect(duplicatePlugins.length).toBe(1)

      // Should have exactly 3 unique plugins
      const pluginNames = plugins.filter(
        (p) => p.includes("global-plugin") || p.includes("local-plugin") || p.includes("duplicate-plugin"),
      )
      expect(pluginNames.length).toBe(3)
    },
  })
})

// Legacy tools migration tests

test("migrates legacy tools config to permissions - allow", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          agent: {
            test: {
              tools: {
                bash: true,
                read: true,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]?.permission).toEqual({
        bash: "allow",
        read: "allow",
      })
    },
  })
})

test("migrates legacy tools config to permissions - deny", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          agent: {
            test: {
              tools: {
                bash: false,
                webfetch: false,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]?.permission).toEqual({
        bash: "deny",
        webfetch: "deny",
      })
    },
  })
})

test("migrates legacy write tool to edit permission", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          agent: {
            test: {
              tools: {
                write: true,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]?.permission).toEqual({
        edit: "allow",
      })
    },
  })
})

test("migrates legacy edit tool to edit permission", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          agent: {
            test: {
              tools: {
                edit: false,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]?.permission).toEqual({
        edit: "deny",
      })
    },
  })
})

test("migrates legacy patch tool to edit permission", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          agent: {
            test: {
              tools: {
                patch: true,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]?.permission).toEqual({
        edit: "allow",
      })
    },
  })
})

test("migrates legacy multiedit tool to edit permission", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          agent: {
            test: {
              tools: {
                multiedit: false,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]?.permission).toEqual({
        edit: "deny",
      })
    },
  })
})

test("migrates mixed legacy tools config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          agent: {
            test: {
              tools: {
                bash: true,
                write: true,
                read: false,
                webfetch: true,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]?.permission).toEqual({
        bash: "allow",
        edit: "allow",
        read: "deny",
        webfetch: "allow",
      })
    },
  })
})

test("merges legacy tools with existing permission config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          agent: {
            test: {
              permission: {
                glob: "allow",
              },
              tools: {
                bash: true,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]?.permission).toEqual({
        glob: "allow",
        bash: "allow",
      })
    },
  })
})

test("permission config preserves key order", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          permission: {
            "*": "deny",
            edit: "ask",
            write: "ask",
            external_directory: "ask",
            read: "allow",
            todowrite: "allow",
            todoread: "allow",
            "thoughts_*": "allow",
            "reasoning_model_*": "allow",
            "tools_*": "allow",
            "pr_comments_*": "allow",
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(Object.keys(config.permission!)).toEqual([
        "*",
        "edit",
        "write",
        "external_directory",
        "read",
        "todowrite",
        "todoread",
        "thoughts_*",
        "reasoning_model_*",
        "tools_*",
        "pr_comments_*",
      ])
    },
  })
})

// MCP config merging tests

test("project config can override MCP server enabled status", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Simulates a base config (like from remote .well-known) with disabled MCP
      await Bun.write(
        path.join(dir, "synergy.jsonc"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          mcp: {
            jira: {
              type: "remote",
              url: "https://jira.example.com/mcp",
              enabled: false,
            },
            wiki: {
              type: "remote",
              url: "https://wiki.example.com/mcp",
              enabled: false,
            },
          },
        }),
      )
      // Project config enables just jira
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          mcp: {
            jira: {
              type: "remote",
              url: "https://jira.example.com/mcp",
              enabled: true,
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      // jira should be enabled (overridden by project config)
      expect(config.mcp?.jira).toEqual({
        type: "remote",
        url: "https://jira.example.com/mcp",
        enabled: true,
      })
      // wiki should still be disabled (not overridden)
      expect(config.mcp?.wiki).toEqual({
        type: "remote",
        url: "https://wiki.example.com/mcp",
        enabled: false,
      })
    },
  })
})

test("MCP config deep merges preserving base config properties", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Base config with full MCP definition
      await Bun.write(
        path.join(dir, "synergy.jsonc"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          mcp: {
            myserver: {
              type: "remote",
              url: "https://myserver.example.com/mcp",
              enabled: false,
              headers: {
                "X-Custom-Header": "value",
              },
            },
          },
        }),
      )
      // Override just enables it, should preserve other properties
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          mcp: {
            myserver: {
              type: "remote",
              url: "https://myserver.example.com/mcp",
              enabled: true,
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.mcp?.myserver).toEqual({
        type: "remote",
        url: "https://myserver.example.com/mcp",
        enabled: true,
        headers: {
          "X-Custom-Header": "value",
        },
      })
    },
  })
})

test("local .synergy config can override MCP from project config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Project config with disabled MCP
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          mcp: {
            docs: {
              type: "remote",
              url: "https://docs.example.com/mcp",
              enabled: false,
            },
          },
        }),
      )
      // Local .synergy directory config enables it
      const synergyDir = path.join(dir, ".synergy")
      await fs.mkdir(synergyDir, { recursive: true })
      await Bun.write(
        path.join(synergyDir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          mcp: {
            docs: {
              type: "remote",
              url: "https://docs.example.com/mcp",
              enabled: true,
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.get()
      expect(config.mcp?.docs?.enabled).toBe(true)
    },
  })
})

test("project config overrides remote well-known config", async () => {
  const originalFetch = globalThis.fetch
  let fetchedUrl: string | undefined
  const mockFetch = mock((url: string | URL | Request) => {
    const urlStr = url.toString()
    if (urlStr.includes(".well-known/synergy")) {
      fetchedUrl = urlStr
      return Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              mcp: {
                jira: {
                  type: "remote",
                  url: "https://jira.example.com/mcp",
                  enabled: false,
                },
              },
            },
          }),
          { status: 200 },
        ),
      )
    }
    return originalFetch(url)
  })
  globalThis.fetch = mockFetch as unknown as typeof fetch

  const originalAuthAll = Auth.all
  Auth.all = mock(() =>
    Promise.resolve({
      "https://example.com": {
        type: "wellknown" as const,
        key: "TEST_TOKEN",
        token: "test-token",
      },
    }),
  )

  try {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // Project config enables jira (overriding remote default)
        await Bun.write(
          path.join(dir, "synergy.json"),
          JSON.stringify({
            $schema: "file:///test/config.schema.json",
            mcp: {
              jira: {
                type: "remote",
                url: "https://jira.example.com/mcp",
                enabled: true,
              },
            },
          }),
        )
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const config = await Config.get()
        // Verify fetch was called for wellknown config
        expect(fetchedUrl).toBe("https://example.com/.well-known/synergy")
        // Project config (enabled: true) should override remote (enabled: false)
        expect(config.mcp?.jira?.enabled).toBe(true)
      },
    })
  } finally {
    globalThis.fetch = originalFetch
    Auth.all = originalAuthAll
  }
})
