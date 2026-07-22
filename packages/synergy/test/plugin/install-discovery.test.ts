import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { compilePluginManifest, definePlugin, mcp, operation } from "@ericsanchezok/synergy-plugin"
import { resolvePluginSpec } from "../../src/plugin/spec-resolver"
import { add, PluginApprovalRequiredError, resolveConfiguredPluginId } from "../../src/plugin/install"
import { ScopeContext } from "../../src/scope/context"
import { sha256File } from "../../src/util/crypto"
import { tmpdir } from "../fixture/fixture"

describe("plugin installation discovery", () => {
  test("validates generated metadata without importing runtime code before approval", async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "runtime-imported")
    const runtimeDir = path.join(tmp.path, "runtime")
    const runtimePath = path.join(runtimeDir, "index.js")
    await fs.mkdir(runtimeDir, { recursive: true })
    await Bun.write(runtimePath, `await Bun.write(${JSON.stringify(marker)}, "executed")\nexport default {}\n`)
    const definition = definePlugin({
      id: "discovery-test",
      version: "1.0.0",
      description: "Discovery must be data-only",
      contributions: [
        operation({
          id: "read",
          type: "query",
          input: z.object({}),
          output: z.object({}),
          handler: async () => ({}),
        }),
      ],
    })
    const manifest = compilePluginManifest(definition, {
      generation: "discovery-generation",
      runtime: { entry: "runtime/index.js", sha256: sha256File(runtimePath) },
    })
    await Bun.write(path.join(tmp.path, "plugin.json"), JSON.stringify(manifest))

    const resolved = await resolvePluginSpec(pathToFileURL(tmp.path).href, { install: false })
    expect(resolved.manifest.id).toBe("discovery-test")
    expect(await Bun.file(marker).exists()).toBe(false)

    const tampered = {
      ...manifest,
      artifacts: { ...manifest.artifacts, runtime: { ...manifest.artifacts.runtime!, sha256: "0".repeat(64) } },
    }
    await Bun.write(path.join(tmp.path, "plugin.json"), JSON.stringify(tampered))
    await expect(resolvePluginSpec(pathToFileURL(tmp.path).href, { install: false })).rejects.toThrow(
      "integrity mismatch",
    )
  })

  test("rejects malformed plugin MCP metadata during data-only discovery", async () => {
    await using tmp = await tmpdir()
    const definition = definePlugin({
      id: "invalid-mcp-discovery",
      version: "1.0.0",
      description: "Malformed MCP metadata must fail before activation",
      contributions: [
        mcp({
          id: "remote",
          server: { type: "remote", url: "https://example.com/mcp", startup: "manual" },
        }),
      ],
    })
    const manifest = compilePluginManifest(definition, { generation: "invalid-mcp-generation" })
    const tampered = {
      ...manifest,
      contributions: manifest.contributions.map((contribution) =>
        contribution.kind === "mcp"
          ? { ...contribution, server: { ...contribution.server, url: "file:///tmp/mcp.sock" } }
          : contribution,
      ),
    }
    await Bun.write(path.join(tmp.path, "plugin.json"), JSON.stringify(tampered))

    await expect(resolvePluginSpec(pathToFileURL(tmp.path).href, { install: false })).rejects.toThrow(
      "MCP remote URL must use http or https",
    )
  })

  test("resolves configured relative specs from the active Scope", async () => {
    await using tmp = await tmpdir()
    const pluginDir = path.join(tmp.path, "relative-discovery")
    await fs.mkdir(pluginDir, { recursive: true })
    const definition = definePlugin({
      id: "relative-discovery",
      version: "1.0.0",
      description: "Relative discovery uses the active Scope",
      contributions: [],
    })
    const manifest = compilePluginManifest(definition, { generation: "relative-discovery-generation" })
    await Bun.write(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest))
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      async fn() {
        expect(await resolveConfiguredPluginId("file://./relative-discovery")).toBe("relative-discovery")
        await expect(add("file://./relative-discovery", { source: "official" })).rejects.toBeInstanceOf(
          PluginApprovalRequiredError,
        )
      },
    })
  })
})
