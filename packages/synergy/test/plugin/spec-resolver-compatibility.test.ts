import { describe, expect, test } from "bun:test"
import path from "node:path"
import { assertPluginCompatibility, readPluginManifest } from "../../src/plugin/spec-resolver"

describe("Plugin API compatibility", () => {
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
