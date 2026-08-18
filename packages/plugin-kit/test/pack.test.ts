import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { buildPluginProject } from "../src/commands/build"
import { PluginPackCommand, packPluginProject, readBuiltManifest } from "../src/commands/pack"
import { extractTarballText } from "../src/lib/tarball"
import {
  captureStdout,
  createFixtureProject,
  minimalPluginSource,
  restoreExitCode,
  writeMinimalPlugin,
} from "./fixtures"

function builtProject(source: string, id = "pack-fixture") {
  const project = createFixtureProject("pack-")
  writeMinimalPlugin(project, source, id)
  return project
}

describe("readBuiltManifest", () => {
  test("throws when dist/plugin.json is missing", () => {
    const project = createFixtureProject("pack-manifest-")
    try {
      writeMinimalPlugin(project, minimalPluginSource("pack-manifest"))
      expect(() => readBuiltManifest(project.root)).toThrow(/Built manifest not found/)
    } finally {
      project.cleanup()
    }
  })
})

describe("packPluginProject", () => {
  test("packs a built project into a tarball with a manifest", async () => {
    const project = builtProject(minimalPluginSource("pack-fixture"))
    try {
      expect(await buildPluginProject(project.root)).toBe(true)
      const archivePath = packPluginProject(project.root)
      expect(archivePath).toBe(path.join(project.root, "pack-fixture-1.0.0.synergy-plugin.tgz"))
      expect(fs.existsSync(archivePath)).toBe(true)

      const manifest = PluginManifest.parse(JSON.parse(extractTarballText(archivePath, "plugin.json") ?? "{}"))
      expect(manifest.id).toBe("pack-fixture")
      expect(extractTarballText(archivePath, "integrity.json")).toBeTruthy()
      expect(extractTarballText(archivePath, "permissions.summary.json")).toBeTruthy()
    } finally {
      project.cleanup()
    }
  })

  test("throws when required files are missing", () => {
    const project = builtProject(minimalPluginSource("pack-missing"))
    try {
      expect(() => packPluginProject(project.root)).toThrow(/Built manifest not found/)
    } finally {
      project.cleanup()
    }
  })

  test("reports missing runtime artifacts", async () => {
    const project = builtProject(
      `import { definePlugin, operation } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "pack-runtime",
  version: "1.0.0",
  description: "Runtime fixture",
  contributions: [operation({
    id: "ping", type: "query", input: {}, output: {},
    handler: async () => ({ ok: true }),
  })],
})
`,
      "pack-runtime",
    )
    try {
      expect(await buildPluginProject(project.root)).toBe(true)
      fs.rmSync(path.join(project.root, "dist", "runtime"), { recursive: true, force: true })
      expect(() => packPluginProject(project.root)).toThrow(/Runtime artifact is missing/)
    } finally {
      project.cleanup()
    }
  })

  test("PluginPackCommand handles failures and success", async () => {
    const project = createFixtureProject("pack-command-")
    try {
      writeMinimalPlugin(project, minimalPluginSource("pack-command"))
      const previousExitCode = process.exitCode
      try {
        await captureStdout(() => PluginPackCommand.handler!({ path: project.root } as never))
        expect(process.exitCode).toBe(1)
      } finally {
        restoreExitCode(previousExitCode)
      }

      expect(await buildPluginProject(project.root)).toBe(true)
      const { output } = await captureStdout(() => PluginPackCommand.handler!({ path: project.root } as never))
      expect(output).toContain("Packed")
    } finally {
      project.cleanup()
    }
  })
})
