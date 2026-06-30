import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { PluginBuildCommand } from "../../src/cli/cmd/plugin-build"
import { PluginCreateCommand } from "../../src/cli/cmd/plugin-create"
import { PluginPackCommand } from "../../src/cli/cmd/plugin-pack"
import { PluginValidateCommand } from "../../src/cli/cmd/plugin-validate"
import { PLUGIN_PROTOCOL_MIN_SYNERGY_RANGE, PluginManifest } from "@ericsanchezok/synergy-plugin"
import { baseCapabilities } from "@ericsanchezok/synergy-plugin/permissions"
import { sha256File } from "../../../plugin-kit/src/lib/crypto"
import { computeManifestHash, computePermissionsHash } from "../../../plugin-kit/src/lib/hash"
import { copyRegistryEntryIcon, registryEntry, writeRegistryEntry } from "../../../plugin-kit/src/lib/market-entry"

const repoRoot = path.resolve(import.meta.dir, "../../../..")
const repoNodeModules = path.join(repoRoot, "node_modules")
const templates = ["tool-ui", "workspace-panel", "api-connector", "theme-icon"] as const

async function runCommand(command: { handler: (args: any) => Promise<void> | void }, args: Record<string, unknown>) {
  process.exitCode = undefined
  await command.handler(args as any)
  expect(process.exitCode ?? 0).toBe(0)
}

describe("plugin scaffold toolchain", () => {
  test("generated templates validate, build, and pack with the current plugin API", async () => {
    await using tmp = await tmpdir()
    const previousCwd = process.cwd()
    process.chdir(tmp.path)

    try {
      for (const template of templates) {
        const name = `scaffold-${template}`
        await runCommand(PluginCreateCommand, { name, template })

        const pluginDir = path.join(tmp.path, name)
        await fs.symlink(repoNodeModules, path.join(pluginDir, "node_modules"), "dir")

        await runCommand(PluginValidateCommand, { path: pluginDir, "runtime-discovery": true })
        await runCommand(PluginBuildCommand, { path: pluginDir })
        await runCommand(PluginPackCommand, { path: pluginDir })

        const manifest = await Bun.file(path.join(pluginDir, "dist", "plugin.json")).json()
        expect(manifest.name).toBe(name)
        expect(manifest.engines?.synergy).toBe(PLUGIN_PROTOCOL_MIN_SYNERGY_RANGE)
        expect(manifest.main).toBe("./runtime/index.js")
        if (manifest.contributes?.ui?.entry) {
          expect(manifest.contributes.ui.entry).toMatch(/^\.\/ui\/index\.js$/)
          expect(await Bun.file(path.join(pluginDir, "dist", "ui", "index.js")).exists()).toBe(true)
        }
        expect(await Bun.file(path.join(pluginDir, `${name}-0.1.0.synergy-plugin.tgz`)).exists()).toBe(true)
      }
    } finally {
      process.chdir(previousCwd)
      process.exitCode = undefined
    }
  })

  test("build and pack include manifest-declared contribution assets", async () => {
    await using tmp = await tmpdir()
    const pluginDir = path.join(tmp.path, "asset-fixture")
    await fs.mkdir(path.join(pluginDir, "src"), { recursive: true })
    await fs.mkdir(path.join(pluginDir, "skills", "frontend"), { recursive: true })
    await fs.mkdir(path.join(pluginDir, "scripts"), { recursive: true })
    await fs.mkdir(path.join(pluginDir, "themes"), { recursive: true })
    await fs.mkdir(path.join(pluginDir, "icons"), { recursive: true })

    await Bun.write(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify(
        {
          name: "asset-fixture",
          version: "0.1.0",
          description: "Fixture plugin with declared contribution assets",
          icon: "./icons/market.svg",
          main: "./src/index.ts",
          contributes: {
            skills: [{ name: "frontend", description: "Frontend workflow skill", dir: "./skills/frontend" }],
            ui: {
              entry: "./dist/ui/index.js",
              routes: [{ path: "/asset-fixture", entry: "./src/route.js", label: "Fixture" }],
              workspacePanels: [
                {
                  id: "asset-panel",
                  label: "Fixture",
                  icon: "panel-left",
                  sandbox: true,
                  sandboxEntry: "./src/panel-sandbox.js",
                },
              ],
              settings: [
                {
                  id: "asset-settings",
                  label: "Fixture",
                  icon: "settings",
                  group: "fixture",
                  sandbox: true,
                  sandboxEntry: "./src/settings-sandbox.js",
                },
              ],
              themes: [{ id: "asset-theme", label: "Fixture", path: "./themes/default.css" }],
              icons: [{ name: "asset-logo", path: "./icons/logo.svg" }],
            },
          },
          lifecycle: {
            install: "./scripts/install.ts",
          },
        },
        null,
        2,
      ),
    )
    await Bun.write(
      path.join(pluginDir, "src", "index.ts"),
      `import type { PluginDescriptor } from "@ericsanchezok/synergy-plugin"

const plugin: PluginDescriptor = {
  id: "asset-fixture",
  async init() {
    return {}
  },
}

export default plugin
`,
    )
    await Bun.write(path.join(pluginDir, "src", "ui.tsx"), "export default function Fixture() { return null }\n")
    await Bun.write(path.join(pluginDir, "src", "route.js"), "export default function Route() { return null }\n")
    await Bun.write(path.join(pluginDir, "src", "panel-sandbox.js"), "export default function Panel() {}\n")
    await Bun.write(path.join(pluginDir, "src", "settings-sandbox.js"), "export default function Settings() {}\n")
    await Bun.write(path.join(pluginDir, "skills", "frontend", "SKILL.md"), "# Frontend\n")
    await Bun.write(path.join(pluginDir, "scripts", "install.ts"), "export default async function install() {}\n")
    await Bun.write(path.join(pluginDir, "themes", "default.css"), ":root { --asset-fixture: #2563eb; }\n")
    await Bun.write(
      path.join(pluginDir, "icons", "logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>\n',
    )
    await Bun.write(
      path.join(pluginDir, "icons", "market.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>\n',
    )

    await runCommand(PluginBuildCommand, { path: pluginDir })
    await runCommand(PluginPackCommand, { path: pluginDir })

    const expectedFiles = [
      "dist/plugin.json",
      "dist/runtime/index.js",
      "dist/ui/index.js",
      "dist/src/route.js",
      "dist/src/panel-sandbox.js",
      "dist/src/settings-sandbox.js",
      "dist/skills/frontend/SKILL.md",
      "dist/scripts/install.ts",
      "dist/themes/default.css",
      "dist/icons/logo.svg",
      "dist/icons/market.svg",
    ]
    for (const relative of expectedFiles) {
      expect(await Bun.file(path.join(pluginDir, relative)).exists()).toBe(true)
    }

    const integrity = await Bun.file(path.join(pluginDir, "dist", "integrity.json")).json()
    expect(integrity.files["skills/frontend/SKILL.md"]).toBeDefined()
    expect(integrity.files["src/route.js"]).toBeDefined()
    expect(integrity.files["src/panel-sandbox.js"]).toBeDefined()
    expect(integrity.files["scripts/install.ts"]).toBeDefined()
    expect(integrity.files["icons/market.svg"]).toBeDefined()

    const tarball = path.join(pluginDir, "asset-fixture-0.1.0.synergy-plugin.tgz")
    const list = Bun.spawnSync(["tar", "-tzf", tarball], { stdout: "pipe", stderr: "pipe" })
    expect(list.exitCode).toBe(0)
    const files = new Set(
      new TextDecoder()
        .decode(list.stdout)
        .split("\n")
        .map((line) => line.replace(/^\.\//, "").replace(/\/$/, ""))
        .filter(Boolean),
    )
    expect(files.has("skills/frontend/SKILL.md")).toBe(true)
    expect(files.has("src/route.js")).toBe(true)
    expect(files.has("src/panel-sandbox.js")).toBe(true)
    expect(files.has("scripts/install.ts")).toBe(true)
    expect(files.has("icons/market.svg")).toBe(true)

    const manifest = PluginManifest.parse(await Bun.file(path.join(pluginDir, "dist", "plugin.json")).json())
    const capabilities = baseCapabilities(manifest)
    await Bun.write(
      `${tarball}.sig`,
      JSON.stringify(
        {
          signatureVersion: 1,
          pluginId: "asset-fixture",
          version: "0.1.0",
          algorithm: "ed25519",
          signer: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          signature: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          signedAt: 1,
          payload: {
            tarballHash: sha256File(tarball),
            manifestHash: computeManifestHash(manifest),
            permissionsHash: computePermissionsHash(manifest, capabilities),
          },
        },
        null,
        2,
      ),
    )

    const entry = registryEntry({
      tarballPath: tarball,
      repo: "https://github.com/example/asset-fixture",
      publishedAt: "2026-06-27T00:00:00.000Z",
    })
    expect(entry.icon).toEqual({ type: "registry-svg", path: "icons/asset-fixture.svg" })
    expect("compatibility" in entry).toBe(false)

    const registryEntryPath = path.join(tmp.path, "registry", "plugins", "asset-fixture.json")
    writeRegistryEntry(registryEntryPath, entry)
    const copiedIcon = copyRegistryEntryIcon({ tarballPath: tarball, entryPath: registryEntryPath, entry })
    expect(copiedIcon).toBe(path.join(tmp.path, "registry", "icons", "asset-fixture.svg"))
    expect(await Bun.file(copiedIcon!).exists()).toBe(true)

    const customTagEntry = registryEntry({
      tarballPath: tarball,
      repo: "https://github.com/example/asset-fixture",
      releaseTagTemplate: "asset-fixture-{version}",
    })
    expect(customTagEntry.versions[0]?.downloadUrl).toContain("/releases/download/asset-fixture-0.1.0/")
  })
})
