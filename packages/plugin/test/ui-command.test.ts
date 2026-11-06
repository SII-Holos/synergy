import { expect, test } from "bun:test"
import { z } from "zod"
import {
  capability,
  compilePluginManifest,
  definePlugin,
  operation,
  PluginManifest,
  uiCommand,
  uiMenu,
  matchesPluginUICondition,
  PluginUICondition,
} from "../src"

test("UI commands and menus compile to finite metadata with declared operation references", () => {
  const definition = definePlugin({
    id: "command-test",
    version: "1.0.0",
    description: "Commands",
    capabilities: [capability("ui.commands")],
    contributions: [
      operation({
        id: "refresh",
        type: "command",
        input: z.object({}),
        output: z.boolean(),
        handler: async () => true,
      }),
      uiCommand({
        id: "refresh",
        title: "Refresh",
        operation: "refresh",
        when: { pages: ["session"] },
        enabledWhen: { session: true },
        keybind: "mod+shift+r",
      }),
      uiMenu({ id: "refresh", command: "refresh", location: "session.header.actions" }),
    ],
  })
  const manifest = PluginManifest.parse(
    compilePluginManifest(definition, {
      generation: "generation",
      runtime: { entry: "runtime.js", sha256: "a".repeat(64) },
    }),
  )
  expect(manifest.contributions[1]).toMatchObject({
    kind: "ui.command",
    requires: ["ui.commands"],
    operation: "refresh",
  })
  const broken = structuredClone(manifest)
  const menu = broken.contributions.find((item) => item.kind === "ui.menu")!
  menu.command = "missing"
  expect(() => PluginManifest.parse(broken)).toThrow("Undeclared UI command")
  expect(() =>
    PluginManifest.parse({
      ...manifest,
      contributions: manifest.contributions.map((item) =>
        item.kind === "ui.command" ? { ...item, operation: "missing" } : item,
      ),
    }),
  ).toThrow("UI-exposed command operation")
})

test("UI conditions reject expressions and evaluate changing bounded context", () => {
  expect(PluginUICondition.safeParse({ expression: "window.location" }).success).toBe(false)
  const condition = { session: true, pages: ["session" as const], platform: "desktop" as const }
  expect(matchesPluginUICondition(condition, { session: true, page: "session", platform: "desktop" })).toBe(true)
  expect(matchesPluginUICondition(condition, { session: false, page: "session", platform: "desktop" })).toBe(false)
  expect(matchesPluginUICondition(condition, { session: true, page: "session", platform: "web" })).toBe(false)
})
