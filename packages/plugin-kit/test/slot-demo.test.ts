import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { buildPluginProject } from "../src/commands/build"
import { validatePluginProject } from "../src/commands/validate"
import { createFixtureProject } from "./fixtures"

/**
 * Steampunk surface demo: one plugin contributing to every host-declared slot
 * plus a plugin-owned CSS surface (parchment/metal texture styling). This is
 * the reference for "styled surfaces" — the theme color contract is untouched;
 * the component owns its CSS with a pluginId-prefixed selector.
 */
const steampunkPlugin = `import { definePlugin, slot } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "steampunk-surfaces",
  version: "1.0.0",
  description: "Steampunk slot surfaces demo",
  contributions: [
    slot({
      id: "status",
      slot: "sidebar.footer",
      label: "Boiler status",
      component: { source: "./src/ui.tsx", exportName: "SidebarFooter" },
    }),
    slot({
      id: "header-actions",
      slot: "session.header.actions",
      label: "Pressure gauge",
      when: { session: true },
      component: { source: "./src/ui.tsx", exportName: "SessionHeaderActions" },
    }),
    slot({
      id: "welcome",
      slot: "session.empty",
      label: "Workshop welcome",
      component: { source: "./src/ui.tsx", exportName: "SessionEmpty" },
    }),
    slot({
      id: "footer",
      slot: "app.footer",
      label: "Workshop footer",
      component: { source: "./src/ui.tsx", exportName: "AppFooter" },
    }),
    slot({
      id: "surface",
      slot: "settings.section",
      label: "Workshop theme",
      component: { source: "./src/ui.tsx", exportName: "SettingsSection" },
    }),
  ],
})
`

const steampunkUI = `import type { Component } from "solid-js"
import type { PluginSurfaceContext } from "@ericsanchezok/synergy-plugin/ui"
import "./steampunk.css"

const Box: Component<{ context: PluginSurfaceContext; label: string }> = (props) => (
  <section class="steampunk-surfaces" aria-label={props.context.surface.id}>
    <span class="steampunk-surfaces-label">{props.label}</span>
  </section>
)

export const SidebarFooter: Component<{ context: PluginSurfaceContext }> = (props) => (
  <Box context={props.context} label="Boiler: 12 psi" />
)
export const SessionHeaderActions: Component<{ context: PluginSurfaceContext }> = (props) => (
  <Box context={props.context} label="Pressure" />
)
export const SessionEmpty: Component<{ context: PluginSurfaceContext }> = (props) => (
  <Box context={props.context} label="Start the workshop" />
)
export const AppFooter: Component<{ context: PluginSurfaceContext }> = (props) => (
  <Box context={props.context} label="Steampunk workshop" />
)
export const SettingsSection: Component<{ context: PluginSurfaceContext }> = (props) => (
  <Box context={props.context} label="Workshop surface" />
)
`

const steampunkCSS = `.steampunk-surfaces {
  /* Parchment/metal texture is component-owned; prefix selectors with the
     plugin id to avoid colliding with host or other plugin styles. */
  background:
    linear-gradient(135deg, rgba(120, 90, 20, 0.18), rgba(30, 20, 5, 0.22)),
    repeating-linear-gradient(45deg, rgba(120, 90, 20, 0.08) 0 1px, transparent 1px 6px);
  border: 1px solid var(--border-strong-base);
  border-radius: var(--radius-md, 8px);
  color: var(--text-base);
  padding: 6px 10px;
  font-size: 12px;
}
.steampunk-surfaces-label {
  font-weight: 600;
}
`

describe("steampunk slot surfaces demo plugin", () => {
  test("builds and validates all five slot contributions plus plugin-owned CSS", async () => {
    const project = createFixtureProject("steampunk-surfaces")
    try {
      project.writeFile(
        "package.json",
        `${JSON.stringify(
          {
            name: "steampunk-surfaces",
            version: "1.0.0",
            type: "module",
            source: "./src/index.ts",
            dependencies: {
              "@ericsanchezok/synergy-plugin": "latest",
              "solid-js": "^1.9.0",
            },
            devDependencies: {
              "@ericsanchezok/synergy-plugin-kit": "latest",
              typescript: "^5.8.0",
            },
          },
          null,
          2,
        )}\n`,
      )
      project.writeFile("src/index.ts", steampunkPlugin)
      project.writeFile("src/ui.tsx", steampunkUI)
      project.writeFile("src/steampunk.css", steampunkCSS)

      expect(await buildPluginProject(project.root)).toBe(true)
      const manifest = PluginManifest.parse(
        JSON.parse(fs.readFileSync(path.join(project.root, "dist", "plugin.json"), "utf-8")),
      )

      const slots = manifest.contributions
        .filter((item) => item.kind === "ui.slot")
        .map((item) => (item.kind === "ui.slot" ? `${item.id}:${item.slot}` : item.kind))
      expect(slots).toEqual([
        "status:sidebar.footer",
        "header-actions:session.header.actions",
        "welcome:session.empty",
        "footer:app.footer",
        "surface:settings.section",
      ])
      const headerAction = manifest.contributions.find(
        (item) => item.kind === "ui.slot" && item.id === "header-actions",
      )
      expect(headerAction).toMatchObject({ kind: "ui.slot", when: { session: true } })
      // plugin-owned CSS is extracted next to the UI bundle and present in dist.
      expect(fs.existsSync(path.join(project.root, "dist", "ui", "index.css"))).toBe(true)
      const css = fs.readFileSync(path.join(project.root, "dist", "ui", "index.css"), "utf-8")
      expect(css).toContain(".steampunk-surfaces")

      expect((await validatePluginProject(project.root)).filter((result) => result.type === "error")).toEqual([])
    } finally {
      project.cleanup()
    }
  })
})
