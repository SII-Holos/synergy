import { expect, test } from "bun:test"
import { capability, compilePluginManifest, definePlugin, PluginManifest, shell } from "../src"

test("compiles a Shell and its page renderers with explicit capability ownership", () => {
  const definition = definePlugin({
    id: "custom-workbench",
    version: "1.0.0",
    description: "Custom workbench",
    capabilities: [capability("ui.shell")],
    contributions: [
      shell({
        id: "main",
        label: "Workbench",
        component: { source: "./shell.tsx" },
        pages: { session: { source: "./session.tsx" } },
      }),
    ],
  })
  const manifest = PluginManifest.parse(
    compilePluginManifest(definition, {
      generation: "generation",
      ui: {
        apiVersion: "5.0",
        entry: "ui/index.js",
        sha256: "a".repeat(64),
        resources: [],
        exports: { "ui.shell:main": "Shell", "ui.shell:main:session": "Session" },
      },
    }),
  )
  expect(manifest.contributions[0]).toMatchObject({
    kind: "ui.shell",
    requires: ["ui.shell"],
    component: { entry: "ui/index.js", exportName: "Shell" },
    pages: { session: { entry: "ui/index.js", exportName: "Session" } },
  })
  const tampered = structuredClone(manifest)
  tampered.contributions[0]!.requires = []
  expect(() => PluginManifest.parse(tampered)).toThrow("ui.shell")
  expect(() =>
    definePlugin({
      id: "unapproved-shell",
      version: "1.0.0",
      description: "Missing capability",
      contributions: [shell({ id: "main", label: "Main", component: { source: "./shell.tsx" } })],
    }),
  ).toThrow("ui.shell")
})

test("UI API 5 artifacts declare the first supporting host release", () => {
  const definition = definePlugin({ id: "new-ui", version: "1.0.0", description: "UI minimum", contributions: [] })
  const manifest = compilePluginManifest(definition, {
    generation: "generation",
    ui: { apiVersion: "5.0", entry: "ui/index.js", sha256: "a".repeat(64), exports: {} },
  })
  expect(manifest.compatibility.synergy).toBe(">=3.0.23")
  expect(compilePluginManifest(definition, { generation: "generation" }).compatibility.synergy).toBe(">=3.0.11")
})
