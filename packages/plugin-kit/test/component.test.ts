import { expect, test } from "bun:test"
import { pluginKit } from "../src/component"

test("Plugin Kit contributes author commands only when explicitly selected", async () => {
  const component = pluginKit()
  expect(component.id).toBe("plugin-kit")
  expect(component.requires).toEqual({ "plugin-host": component.version })
  const adapter = await import(component.adapters.cli.href)
  const commands = await adapter.pluginCommands()
  expect(commands.some((item: { command: string }) => item.command.startsWith("create"))).toBe(true)
  expect(commands.some((item: { command: string }) => item.command.startsWith("build"))).toBe(true)
})
