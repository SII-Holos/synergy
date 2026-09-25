import { expect, test } from "bun:test"
import { FULL_COMPONENTS, presetPackage, resolveBuiltinPackage } from "../src/catalog"
import { fullComponents } from "../src/components"
import { SynergyPackage } from "@ericsanchezok/synergy-plugin/package"

test("published component metadata agrees with the source composition", async () => {
  const factories = new Map(fullComponents().map((component) => [component.id, component]))
  for (const owner of FULL_COMPONENTS) {
    const manifest = await Bun.file(new URL(`../../${owner}/package.json`, import.meta.url)).json()
    const metadata = SynergyPackage.parse(manifest.synergy)
    expect(metadata.kind).toBe("component")
    if (metadata.kind !== "component") throw new Error("Expected component")
    const factory = factories.get(metadata.id)!
    expect(factory).toBeDefined()
    expect(factory.apiVersion).toBe(metadata.apiVersion)
    expect(factory.version).toBe(metadata.version)
    expect(factory.requires).toEqual(metadata.requires)
    factories.delete(metadata.id)
  }
  expect(factories.size).toBe(0)
})

test("core, full, Web and Desktop describe distinct installable selections", () => {
  const version = "2.0.0"
  expect(presetPackage("core", version).synergy.packages).toEqual({})
  const full = presetPackage("full", version).synergy.packages
  expect(full["@ericsanchezok/synergy-server"]).toBe(version)
  expect(full["@ericsanchezok/synergy-mcp"]).toBe(version)
  expect(full["@ericsanchezok/synergy-plugin-kit"]).toBe(version)
  expect(Object.keys(full).some((name) => /web-app|desktop-app/.test(name))).toBe(false)
  expect(presetPackage("web", version).synergy.packages).toEqual({
    "@ericsanchezok/synergy-full": version,
    "@ericsanchezok/synergy-web-app": version,
  })
  expect(presetPackage("desktop", version).synergy.packages).toEqual({
    "@ericsanchezok/synergy-web": version,
    "@ericsanchezok/synergy-desktop-app": version,
  })
})

test("built-in shortcuts resolve to concrete versioned packages and preserve external sources", () => {
  expect(resolveBuiltinPackage("mcp", "2.0.0")).toBe("@ericsanchezok/synergy-mcp@2.0.0")
  expect(resolveBuiltinPackage("browser", "2.0.0")).toBe("@ericsanchezok/synergy-browser-runtime@2.0.0")
  expect(resolveBuiltinPackage("desktop", "2.0.0")).toBe("@ericsanchezok/synergy-desktop@2.0.0")
  expect(resolveBuiltinPackage("@company/tools@3.0.0", "2.0.0")).toBe("@company/tools@3.0.0")
  expect(resolveBuiltinPackage("github:company/tools#release", "2.0.0")).toBe("github:company/tools#release")
})
