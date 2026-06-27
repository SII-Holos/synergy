import { test, expect, mock } from "bun:test"
import { Config } from "../../src/config/config"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Auth } from "../../src/provider/api-key"
import { tmpdir } from "../fixture/fixture"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { parse as parseJsonc } from "jsonc-parser"
import { resetMigrations, runMigrations } from "../../src/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"

test("loads config with defaults when no files exist", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      // Strict schema should throw an error for invalid fields
      await expect(Config.current()).rejects.toThrow()
    },
  })
})

test("throws error for invalid JSON", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "synergy.json"), "{ invalid json }")
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await expect(Config.current()).rejects.toThrow()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const newConfig = { model: "updated/model" }
      await Config.update(newConfig as any)

      const filepath = path.join(tmp.path, ".synergy", "synergy.d", "10-models.jsonc")
      const writtenConfig = parseJsonc(await Bun.file(filepath).text(), [], { allowTrailingComma: true }) as any
      expect(writtenConfig.model).toBe("updated/model")
    },
  })
})

test("gets config directories", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
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

  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      // Bun 1.3.13: import.meta.resolve from file:/// URLs on Windows fails for
      // scoped npm packages. The production plugin resolver (in src/config/config.ts)
      // also uses import.meta.resolve, so this test is gated on the Bun bug being fixed.
      // Tracked as: Bun #<unknown> — file:/// scoped package resolution on Windows.
      if (process.platform === "win32") return

      const config = await Config.current()
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

  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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

  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await Config.state.reset()
      const config = await Config.current()
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

  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await Config.state.reset()
      const config = await Config.current()
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

  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await Config.state.reset()
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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

test("migrates legacy channel holos config to top-level holos", async () => {
  const home = path.join(os.tmpdir(), `synergy-config-holos-migration-${Math.random().toString(36).slice(2)}`)
  const origHome = process.env["SYNERGY_TEST_HOME"]
  try {
    process.env["SYNERGY_TEST_HOME"] = home
    const configHome = path.join(home, ".synergy", "config")
    await fs.mkdir(configHome, { recursive: true })
    const target = path.join(configHome, "synergy.jsonc")
    await Bun.write(
      target,
      `{
  "$schema": "file:///test/config.schema.json",
  "channel": {
    "holos": {
      "type": "holos",
      "apiUrl": "https://api.holosai.io",
      "wsUrl": "wss://api.holosai.io",
      "portalUrl": "https://www.holosai.io",
      "accounts": {
        "default": {
          "enabled": true
        }
      }
    }
  }
}`,
    )

    resetMigrations()
    await runMigrations()

    const migrated = parseJsonc(await Bun.file(target).text()) as Record<string, any>
    expect(migrated.holos).toEqual({
      enabled: true,
      apiUrl: "https://api.holosai.io",
      wsUrl: "wss://api.holosai.io",
      portalUrl: "https://www.holosai.io",
    })
    expect(migrated.channel).toBeUndefined()
  } finally {
    process.env["SYNERGY_TEST_HOME"] = origHome
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test("removes legacy channel holos config when top-level holos already exists", async () => {
  const home = path.join(os.tmpdir(), `synergy-config-holos-migration-${Math.random().toString(36).slice(2)}`)
  const origHome = process.env["SYNERGY_TEST_HOME"]
  try {
    process.env["SYNERGY_TEST_HOME"] = home
    const configHome = path.join(home, ".synergy", "config")
    await fs.mkdir(configHome, { recursive: true })
    const target = path.join(configHome, "synergy.jsonc")
    await Bun.write(
      target,
      `{
  "$schema": "file:///test/config.schema.json",
  "channel": {
    "holos": {
      "type": "holos",
      "apiUrl": "https://www.holosai.io",
      "wsUrl": "wss://www.holosai.io",
      "portalUrl": "https://www.holosai.io",
      "accounts": {
        "default": {
          "enabled": true
        }
      }
    }
  },
  "holos": {
    "enabled": true,
    "apiUrl": "https://api.holosai.io",
    "wsUrl": "wss://api.holosai.io",
    "portalUrl": "https://www.holosai.io"
  }
}`,
    )

    resetMigrations()
    await runMigrations()

    const migrated = parseJsonc(await Bun.file(target).text()) as Record<string, any>
    expect(migrated.holos).toEqual({
      enabled: true,
      apiUrl: "https://api.holosai.io",
      wsUrl: "wss://api.holosai.io",
      portalUrl: "https://www.holosai.io",
    })
    expect(migrated.channel).toBeUndefined()
  } finally {
    process.env["SYNERGY_TEST_HOME"] = origHome
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test("migrates legacy auto_classifier config to smartAllow", async () => {
  const home = path.join(os.tmpdir(), `synergy-config-smart-allow-migration-${Math.random().toString(36).slice(2)}`)
  const origHome = process.env["SYNERGY_TEST_HOME"]
  try {
    process.env["SYNERGY_TEST_HOME"] = home
    const configHome = path.join(home, ".synergy", "config")
    await fs.mkdir(configHome, { recursive: true })
    const target = path.join(configHome, "synergy.jsonc")
    await Bun.write(
      target,
      `{
  "$schema": "file:///test/config.schema.json",
  "auto_classifier": true
}`,
    )

    resetMigrations()
    await runMigrations()

    const migrated = parseJsonc(await Bun.file(target).text()) as Record<string, any>
    expect(migrated.smartAllow).toBe(true)
    expect(migrated.auto_classifier).toBeUndefined()
  } finally {
    process.env["SYNERGY_TEST_HOME"] = origHome
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test("migrates project permissions domain auto_classifier config to smartAllow", async () => {
  const home = path.join(os.tmpdir(), `synergy-config-smart-allow-domain-${Math.random().toString(36).slice(2)}`)
  const project = path.join(home, "project")
  const origHome = process.env["SYNERGY_TEST_HOME"]
  const origCwd = process.cwd()
  try {
    process.env["SYNERGY_TEST_HOME"] = home
    const permissionsDir = path.join(project, ".synergy", "synergy.d")
    await fs.mkdir(permissionsDir, { recursive: true })
    const target = path.join(permissionsDir, "80-permissions.jsonc")
    await Bun.write(
      target,
      `{
  "controlProfile": "guarded",
  "auto_classifier": false
}`,
    )

    process.chdir(project)
    resetMigrations()
    await runMigrations()

    const migrated = parseJsonc(await Bun.file(target).text()) as Record<string, any>
    expect(migrated.smartAllow).toBe(false)
    expect(migrated.auto_classifier).toBeUndefined()
  } finally {
    process.chdir(origCwd)
    process.env["SYNERGY_TEST_HOME"] = origHome
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test("removes deprecated autoupdate from monolithic and domain configs", async () => {
  const home = path.join(os.tmpdir(), `synergy-config-autoupdate-migration-${Math.random().toString(36).slice(2)}`)
  const project = path.join(home, "project")
  const origHome = process.env["SYNERGY_TEST_HOME"]
  const origCwd = process.cwd()
  try {
    process.env["SYNERGY_TEST_HOME"] = home
    await fs.mkdir(path.join(home, ".synergy", "config", "synergy.d"), { recursive: true })
    await fs.mkdir(path.join(home, ".synergy", "config", "config-sets", "team", "synergy.d"), { recursive: true })
    await fs.mkdir(path.join(project, ".synergy", "synergy.d"), { recursive: true })

    const monolithic = path.join(home, ".synergy", "config", "synergy.jsonc")
    const globalGeneral = path.join(home, ".synergy", "config", "synergy.d", "00-general.jsonc")
    const setGeneral = path.join(home, ".synergy", "config", "config-sets", "team", "synergy.d", "00-general.jsonc")
    const projectGeneral = path.join(project, ".synergy", "synergy.d", "00-general.jsonc")

    await Bun.write(monolithic, `{"autoupdate": true, "username": "old"}`)
    await Bun.write(globalGeneral, `{"autoupdate": "notify", "theme": "dark"}`)
    await Bun.write(setGeneral, `{"autoupdate": false, "theme": "light"}`)
    await Bun.write(projectGeneral, `{"autoupdate": true, "snapshot": false}`)

    process.chdir(project)
    resetMigrations()
    await runMigrations({ targetDomain: "config" })

    expect((parseJsonc(await Bun.file(monolithic).text()) as Record<string, unknown>).autoupdate).toBeUndefined()
    expect((parseJsonc(await Bun.file(globalGeneral).text()) as Record<string, unknown>).autoupdate).toBeUndefined()
    expect((parseJsonc(await Bun.file(setGeneral).text()) as Record<string, unknown>).autoupdate).toBeUndefined()
    expect((parseJsonc(await Bun.file(projectGeneral).text()) as Record<string, unknown>).autoupdate).toBeUndefined()
  } finally {
    process.chdir(origCwd)
    process.env["SYNERGY_TEST_HOME"] = origHome
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test("migrates legacy identity config to valid library config", async () => {
  const home = path.join(os.tmpdir(), `synergy-config-identity-migration-${Math.random().toString(36).slice(2)}`)
  const origHome = process.env["SYNERGY_TEST_HOME"]
  try {
    process.env["SYNERGY_TEST_HOME"] = home
    const configHome = path.join(home, ".synergy", "config")
    await fs.mkdir(configHome, { recursive: true })
    const target = path.join(configHome, "synergy.jsonc")
    await Bun.write(
      target,
      `{
  "$schema": "file:///test/config.schema.json",
  "identity": {
    "embedding": {
      "baseURL": "https://embedding.example/v1",
      "apiKey": "embedding-token",
      "model": "embed-model"
    },
    "rerank": {
      "baseURL": "https://rerank.example/v1",
      "apiKey": "rerank-token",
      "model": "rerank-model"
    },
    "evolution": {
      "active": {
        "retrieve": {
          "simThreshold": 0.6,
          "topK": 5,
          "categories": {
            "coding": {
              "topK": 2
            }
          }
        },
        "memoryDedupThreshold": 0.8
      },
      "passive": {
        "encode": false,
        "retrieve": {
          "topK": 9
        },
        "learning": {
          "alpha": 0.4
        }
      }
    },
    "autonomy": false
  }
}`,
    )

    resetMigrations()
    await runMigrations({ targetDomain: "config" })

    const migrated = parseJsonc(await Bun.file(target).text()) as Record<string, any>
    expect(migrated.identity).toBeUndefined()
    expect(migrated.embedding).toEqual({
      baseURL: "https://embedding.example/v1",
      apiKey: "embedding-token",
      model: "embed-model",
    })
    expect(migrated.rerank).toEqual({
      baseURL: "https://rerank.example/v1",
      apiKey: "rerank-token",
      model: "rerank-model",
    })
    expect(migrated.library.memory.retrieval.simThreshold).toBe(0.6)
    expect(migrated.library.memory.retrieval.topK).toBe(5)
    expect(migrated.library.memory.retrieval.categories.coding).toEqual({ topK: 2 })
    expect(migrated.library.memory.retrieval.categories.user).toEqual({})
    expect(migrated.library.memory.dedup).toEqual({ threshold: 0.8 })
    expect(migrated.library.experience).toEqual({
      encode: false,
      retrieve: {
        topK: 9,
      },
      learning: {
        alpha: 0.4,
      },
    })
    expect(migrated.library.autonomy).toBe(false)
    expect(Config.Info.safeParse(migrated).success).toBe(true)
  } finally {
    process.env["SYNERGY_TEST_HOME"] = origHome
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test("migrates legacy engram domain config to library and general domains", async () => {
  const home = path.join(os.tmpdir(), `synergy-config-library-domain-migration-${Math.random().toString(36).slice(2)}`)
  const origHome = process.env["SYNERGY_TEST_HOME"]
  try {
    process.env["SYNERGY_TEST_HOME"] = home
    const domainDir = path.join(home, ".synergy", "config", "synergy.d")
    await fs.mkdir(domainDir, { recursive: true })
    const generalFile = path.join(domainDir, "00-general.jsonc")
    const legacyFile = path.join(domainDir, "30-engram.jsonc")
    const libraryFile = path.join(domainDir, "30-library.jsonc")

    await Bun.write(generalFile, JSON.stringify({ theme: "system" }))
    await Bun.write(
      legacyFile,
      JSON.stringify({
        embedding: {
          baseURL: "https://embedding.example/v1",
          apiKey: "embedding-token",
          model: "embed-model",
        },
        rerank: {
          baseURL: "https://rerank.example/v1",
          apiKey: "rerank-token",
          model: "rerank-model",
        },
        engram: {
          memory: {
            enabled: true,
            retrieval: { simThreshold: 0.6, topK: 4 },
          },
          experience: {
            encode: true,
            retrieve: { topK: 9 },
          },
          autonomy: false,
        },
      }),
    )

    resetMigrations()
    await runMigrations({ targetDomain: "config" })

    expect(await Bun.file(legacyFile).exists()).toBe(false)
    const general = parseJsonc(await Bun.file(generalFile).text()) as Record<string, any>
    const library = parseJsonc(await Bun.file(libraryFile).text()) as Record<string, any>
    expect(general.theme).toBe("system")
    expect(general.embedding.model).toBe("embed-model")
    expect(general.rerank.model).toBe("rerank-model")
    expect(library.library.memory.retrieval).toEqual({ simThreshold: 0.6, topK: 4 })
    expect(library.library.experience.retrieve).toEqual({ topK: 9 })
    expect(library.library.autonomy).toBe(false)
    expect(Config.Info.safeParse({ ...general, ...library }).success).toBe(true)
  } finally {
    process.env["SYNERGY_TEST_HOME"] = origHome
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test("repairs invalid library shapes written by legacy identity migration", async () => {
  const home = path.join(os.tmpdir(), `synergy-config-library-repair-${Math.random().toString(36).slice(2)}`)
  const origHome = process.env["SYNERGY_TEST_HOME"]
  try {
    process.env["SYNERGY_TEST_HOME"] = home
    const configHome = path.join(home, ".synergy", "config")
    await fs.mkdir(configHome, { recursive: true })
    const target = path.join(configHome, "synergy.jsonc")
    await Bun.write(
      target,
      JSON.stringify({
        $schema: "file:///test/config.schema.json",
        library: {
          memory: {
            retrieval: false,
          },
          experience: {
            learning: true,
          },
        },
      }),
    )

    resetMigrations()
    await runMigrations({ targetDomain: "config" })

    const migrated = parseJsonc(await Bun.file(target).text()) as Record<string, any>
    expect(migrated.library.memory.enabled).toBe(false)
    expect(migrated.library.memory.retrieval).toBeUndefined()
    expect(migrated.library.experience.learning).toBeUndefined()
    expect(Config.Info.safeParse(migrated).success).toBe(true)
  } finally {
    process.env["SYNERGY_TEST_HOME"] = origHome
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test("provider profile normalize migration rewrites known provider aliases", async () => {
  const home = path.join(
    os.tmpdir(),
    `synergy-config-provider-profile-normalize-${Math.random().toString(36).slice(2)}`,
  )
  const origHome = process.env["SYNERGY_TEST_HOME"]
  try {
    process.env["SYNERGY_TEST_HOME"] = home
    const configHome = path.join(home, ".synergy", "config")
    await fs.mkdir(configHome, { recursive: true })
    const target = path.join(configHome, "synergy.jsonc")
    await Bun.write(
      target,
      JSON.stringify({
        provider: {
          copilot: {
            options: {
              baseURL: "https://api.githubcopilot.com",
            },
          },
        },
        enabled_providers: ["copilot", "openai", "copilot"],
        disabled_providers: ["mimo"],
        model: "copilot/gpt-5.4-mini",
        agent: {
          coder: {
            model: "mimo/mimo-v2.5-pro",
          },
        },
      }),
    )

    resetMigrations()
    await runMigrations({ targetDomain: "config" })

    const migrated = parseJsonc(await Bun.file(target).text()) as Record<string, any>
    expect(migrated.provider["github-copilot"]).toBeDefined()
    expect(migrated.provider.copilot).toBeUndefined()
    expect(migrated.enabled_providers).toEqual(["github-copilot", "openai"])
    expect(migrated.disabled_providers).toEqual(["xiaomi"])
    expect(migrated.model).toBe("github-copilot/gpt-5.4-mini")
    expect(migrated.agent.coder.model).toBe("xiaomi/mimo-v2.5-pro")
  } finally {
    process.env["SYNERGY_TEST_HOME"] = origHome
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
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
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Config.state.reset()
        const config = await Config.current()
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

// MCP lifecycle config tests

test("MCP server config accepts new lifecycle fields", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.jsonc"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          mcp: {
            sidebar: {
              type: "remote",
              url: "https://sidebar.example.com/mcp",
              enabled: true,
              startup: "lazy",
              required: true,
              connectTimeout: 10000,
              listTimeout: 15000,
              callTimeout: 20000,
              retry: {
                maxAttempts: 3,
                backoffMs: 1000,
                backoffMultiplier: 2,
                cooldownMs: 30000,
              },
              idleShutdownMs: 600000,
              toolFilter: { include: ["search"], exclude: ["debug"] },
              tools: { approval: "always", maxOutputBytes: 102400 },
              toolCache: { mode: "session", ttlMs: 300000 },
            },
          },
          mcpDefaults: {
            startup: "eager",
            connectTimeout: 5000,
            callTimeout: 10000,
          },
        }),
      )
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
      const sidebar = config.mcp?.sidebar
      expect(sidebar).toBeDefined()
      if (sidebar && "type" in sidebar) {
        expect(sidebar.startup).toBe("lazy")
        expect(sidebar.required).toBe(true)
        expect(sidebar.connectTimeout).toBe(10000)
        expect(sidebar.listTimeout).toBe(15000)
        expect(sidebar.callTimeout).toBe(20000)
        expect(sidebar.retry).toEqual({ maxAttempts: 3, backoffMs: 1000, backoffMultiplier: 2, cooldownMs: 30000 })
        expect(sidebar.idleShutdownMs).toBe(600000)
        expect(sidebar.toolFilter).toEqual({ include: ["search"], exclude: ["debug"] })
        expect(sidebar.tools).toEqual({ approval: "always", maxOutputBytes: 102400 })
        expect(sidebar.toolCache).toEqual({ mode: "session", ttlMs: 300000 })
      }
      expect(config.mcpDefaults).toEqual({
        startup: "eager",
        connectTimeout: 5000,
        callTimeout: 10000,
      })
    },
  })
})

test("normalizeMcp applies legacy timeout to granular timeouts", () => {
  const server = { type: "remote" as const, url: "https://test.example.com", timeout: 3000 }
  const result = Config.normalizeMcp(server)
  expect(result.connectTimeout).toBe(3000)
  expect(result.listTimeout).toBe(3000)
  expect(result.callTimeout).toBe(3000)
  expect(result.startup).toBe("eager")
})

test("normalizeMcp does not override explicit granular timeouts with legacy", () => {
  const server = {
    type: "remote" as const,
    url: "https://test.example.com",
    timeout: 3000,
    callTimeout: 5000,
  }
  const result = Config.normalizeMcp(server)
  expect(result.connectTimeout).toBe(3000)
  expect(result.listTimeout).toBe(3000)
  expect(result.callTimeout).toBe(5000)
})

test("normalizeMcp applies defaultCallTimeoutMs when callTimeout is missing", () => {
  const server = { type: "remote" as const, url: "https://test.example.com" }
  const result = Config.normalizeMcp(server, undefined, 8000)
  expect(result.callTimeout).toBe(8000)
})

test("normalizeMcp does not override explicit callTimeout with defaultCallTimeoutMs", () => {
  const server = { type: "remote" as const, url: "https://test.example.com", callTimeout: 12000 }
  const result = Config.normalizeMcp(server, undefined, 8000)
  expect(result.callTimeout).toBe(12000)
})

test("normalizeMcp applies mcpDefaults for missing fields", () => {
  const server = { type: "remote" as const, url: "https://test.example.com" }
  const defaults = {
    startup: "lazy" as const,
    required: true,
    connectTimeout: 10000,
    callTimeout: 15000,
  }
  const result = Config.normalizeMcp(server, defaults)
  expect(result.startup).toBe("lazy")
  expect(result.required).toBe(true)
  expect(result.connectTimeout).toBe(10000)
  expect(result.callTimeout).toBe(15000)
})

test("normalizeMcp preserves explicit values over defaults", () => {
  const server = { type: "remote" as const, url: "https://test.example.com", startup: "manual" as const }
  const defaults = { startup: "lazy" as const }
  const result = Config.normalizeMcp(server, defaults)
  expect(result.startup).toBe("manual")
})

test("MCP config preserves backward compatibility with old timeout-only shape", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.jsonc"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          mcp: {
            oldserver: {
              type: "local",
              command: ["node", "server.js"],
              timeout: 5000,
            },
          },
        }),
      )
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
      expect(config.mcp?.oldserver).toBeDefined()
      if (config.mcp?.oldserver && "type" in config.mcp.oldserver) {
        expect(config.mcp.oldserver.timeout).toBe(5000)
      }
    },
  })
})

test("experimental.mcp_timeout does not break config loading", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.jsonc"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          experimental: {
            mcp_timeout: 60000,
          },
          mcp: {
            mymcp: {
              type: "remote",
              url: "https://mcp.example.com",
            },
          },
        }),
      )
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const config = await Config.current()
      expect(config.mcp?.mymcp).toBeDefined()
      expect(config.experimental?.mcp_timeout).toBe(60000)
    },
  })
})
