import { describe, expect, test } from "bun:test"
import { SynergyPackage } from "../src/package"

const base = { formatVersion: 1, id: "example", version: "2.0.0", compatibility: { synergy: "^2.0.0" } }

describe("installable package metadata", () => {
  test("describes host components separately from API4 process plugins", () => {
    expect(
      SynergyPackage.parse({
        ...base,
        kind: "component",
        apiVersion: 1,
        entry: "./dist/component.js",
        export: "example",
      }).kind,
    ).toBe("component")
    expect(SynergyPackage.parse({ ...base, kind: "plugin", manifest: "./plugin.json" }).kind).toBe("plugin")
    expect(
      SynergyPackage.safeParse({ ...base, kind: "plugin", manifest: "./plugin.json", entry: "./evil.js" }).success,
    ).toBe(false)
    expect(
      SynergyPackage.safeParse({
        ...base,
        kind: "component",
        apiVersion: 4,
        entry: "./dist/component.js",
        export: "example",
      }).success,
    ).toBe(false)
  })

  test("presets describe package selections without executable entrypoints", () => {
    const preset = SynergyPackage.parse({ ...base, kind: "preset", packages: { "@company/tools": "2.0.0" } })
    expect(preset.kind).toBe("preset")
    expect(SynergyPackage.safeParse({ ...base, kind: "preset", packages: {}, entry: "./start.js" }).success).toBe(false)
    expect(SynergyPackage.safeParse({ ...base, kind: "preset", packages: { "../../escape": "2.0.0" } }).success).toBe(
      false,
    )
  })

  test("rejects escaping entrypoints and incomplete application artifacts", () => {
    for (const entry of [
      "../escape.js",
      "/tmp/escape.js",
      "./nested/../../escape.js",
      "./a\\b.js",
      "https://example.com/a.js",
    ]) {
      expect(
        SynergyPackage.safeParse({ ...base, kind: "component", apiVersion: 1, entry, export: "example" }).success,
      ).toBe(false)
    }
    const artifact = {
      target: "darwin-arm64",
      url: "https://example.com/desktop.zip",
      sha256: "a".repeat(64),
      format: "zip",
      executable: "./Synergy.app/Contents/MacOS/Synergy",
      signing: { type: "apple", teamID: "ABCDEFGHIJ" },
    }
    expect(SynergyPackage.parse({ ...base, kind: "app", artifacts: [artifact] }).kind).toBe("app")
    expect(
      SynergyPackage.safeParse({ ...base, kind: "app", artifacts: [{ ...artifact, sha256: undefined }] }).success,
    ).toBe(false)
    expect(
      SynergyPackage.safeParse({
        ...base,
        kind: "app",
        artifacts: [{ ...artifact, url: "http://example.com/app.zip" }],
      }).success,
    ).toBe(false)
  })
})
