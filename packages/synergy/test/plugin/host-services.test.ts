import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { assertPluginManifestCapability } from "../../src/plugin/host-services"

async function writeManifest(dir: string, manifest: Record<string, unknown>) {
  await Bun.write(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2))
}

describe("plugin host services manifest gate", () => {
  test("allows requested permissions declared by the current plugin tool", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(dir, { recursive: true })
        await writeManifest(dir, {
          name: "host-service-plugin",
          version: "0.1.0",
          description: "Host service plugin",
          main: "./runtime/index.js",
          permissions: {
            tools: {
              task: { agents: ["planner"] },
              filesystem: "none",
              shell: false,
              network: false,
              mcp: "none",
            },
          },
          contributes: {
            tools: [
              {
                name: "generate",
                title: "Generate",
                description: "Generate output",
                capabilities: {
                  filesystem: "none",
                  shell: false,
                  network: false,
                },
              },
            ],
          },
        })
      },
    })

    await expect(
      assertPluginManifestCapability({
        pluginDir: tmp.path,
        toolId: "generate",
        permission: "task",
      }),
    ).resolves.toBeUndefined()
  })

  test("rejects permissions not declared by the current plugin tool", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeManifest(dir, {
          name: "host-service-plugin",
          version: "0.1.0",
          description: "Host service plugin",
          main: "./runtime/index.js",
          permissions: {
            tools: {
              filesystem: "none",
              shell: false,
              network: false,
              mcp: "none",
            },
          },
          contributes: {
            tools: [{ name: "generate", title: "Generate", description: "Generate output" }],
          },
        })
      },
    })

    await expect(
      assertPluginManifestCapability({
        pluginDir: tmp.path,
        toolId: "generate",
        permission: "secrets",
      }),
    ).rejects.toThrow('Plugin manifest does not allow capability "secrets"')
  })
})
