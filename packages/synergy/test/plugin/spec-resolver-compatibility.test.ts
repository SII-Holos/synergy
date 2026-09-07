import { describe, expect, test } from "bun:test"
import path from "node:path"
import { compilePluginManifest, definePlugin } from "@ericsanchezok/synergy-plugin"
import { assertPluginCompatibility, readPluginManifest } from "../../src/plugin/spec-resolver"
import { sha256File } from "../../src/util/crypto"
import { tmpdir } from "../fixture/fixture"

describe("Plugin API compatibility", () => {
  test("checks UI resource integrity before any plugin code executes", async () => {
    await using tmp = await tmpdir()
    const script = path.join(tmp.path, "ui/index.js")
    const stylesheet = path.join(tmp.path, "ui/panel.css")
    await Bun.write(script, 'throw new Error("must not execute during discovery")')
    await Bun.write(stylesheet, ".panel { display: grid; }")
    const definition = definePlugin({
      id: "ui-resource-integrity",
      version: "1.0.0",
      description: "UI resources participate in metadata-only validation",
      contributions: [],
    })
    const manifest = compilePluginManifest(definition, {
      generation: "ui-resource-generation",
      ui: {
        apiVersion: "5.0",
        entry: "ui/index.js",
        sha256: sha256File(script),
        resources: [{ entry: "ui/panel.css", kind: "stylesheet", sha256: sha256File(stylesheet) }],
      },
    })
    await Bun.write(path.join(tmp.path, "plugin.json"), JSON.stringify(manifest))
    expect((await readPluginManifest(tmp.path)).artifacts.ui?.apiVersion).toBe("5.0")
    await Bun.write(stylesheet, ".panel { display: none; }")
    await expect(readPluginManifest(tmp.path)).rejects.toThrow("ui resource artifact integrity mismatch")
  })

  test("accepts API 4 across compatible Synergy releases", () => {
    expect(() =>
      assertPluginCompatibility(
        { manifestVersion: 1, apiVersion: "4.0", compatibility: { synergy: ">=3.0.11" } },
        "3.8.0",
      ),
    ).not.toThrow()
  })

  test("loads the frozen first-release API4 artifact without rebuilding it", async () => {
    const fixture = path.join(import.meta.dir, "fixtures", "api4-first-release")
    const manifest = await readPluginManifest(fixture)
    expect(manifest).toMatchObject({
      id: "api4-first-release-fixture",
      apiVersion: "4.0",
      compatibility: { synergy: ">=3.0.11" },
    })
  })

  test("rejects an unsupported host before importing plugin code", () => {
    expect(() =>
      assertPluginCompatibility(
        { manifestVersion: 1, apiVersion: "4.0", compatibility: { synergy: ">=4.2.0" } },
        "4.1.9",
      ),
    ).toThrow("requires Synergy >=4.2.0")
  })

  test("rejects pre-GA API 3 with an actionable error", () => {
    expect(() =>
      assertPluginCompatibility(
        { manifestVersion: 1, apiVersion: "3.0", compatibility: { synergy: ">=2.0.0" } },
        "3.8.0",
      ),
    ).toThrow("Plugin API 3.0 is not supported")
  })

  test("rejects a future API family without treating the artifact as damaged", () => {
    expect(() =>
      assertPluginCompatibility(
        { manifestVersion: 1, apiVersion: "5.0", compatibility: { synergy: ">=4.0.0" } },
        "4.8.0",
      ),
    ).toThrow("Plugin API 5.0 is not supported")
  })

  test("allows local development builds", () => {
    expect(() =>
      assertPluginCompatibility(
        { manifestVersion: 1, apiVersion: "4.0", compatibility: { synergy: ">=99.0.0" } },
        "local",
      ),
    ).not.toThrow()
  })
})
