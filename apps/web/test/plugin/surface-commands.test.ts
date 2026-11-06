import { expect, test } from "bun:test"
import { createCommandRegistry } from "../../src/context/command-registry"
import { createPluginSurfaceCommands } from "../../src/plugin/surface-commands"
import { createPluginSurfaceLifetime } from "../../src/plugin/surface-lifetime"
import { createPluginSurfaceAccess } from "../../src/plugin/surface-access"
import { createPluginMenuRegistry } from "../../src/plugin/registries/menu-registry"

test("plugin commands use namespaces and release commands and menus with the instance", async () => {
  const commands = createCommandRegistry()
  const menus = createPluginMenuRegistry()
  const lifetimes = [createPluginSurfaceLifetime(() => {}), createPluginSurfaceLifetime(() => {})]
  let calls = 0
  const services = lifetimes.map((lifetime, index) =>
    createPluginSurfaceCommands({
      pluginId: `plugin-${index}`,
      commands,
      menus,
      lifetime: lifetime.context,
      access: createPluginSurfaceAccess({
        lifetime: lifetime.context,
        capabilities: ["ui.commands"],
        current: () => true,
      }),
      context: () => ({ session: true, page: "session", platform: "web", visible: true }),
      reportError() {},
    }),
  )
  for (const service of services)
    service.register({
      id: "run",
      title: "Run",
      execute: async () => {
        calls++
      },
      menus: [{ location: "app.footer" }],
    })
  expect(
    commands
      .options()
      .map((item) => item.id)
      .toSorted(),
  ).toEqual(["plugin-0:run", "plugin-1:run"])
  expect(menus.list("app.footer")).toHaveLength(2)
  expect(await services[0].execute("run")).toBe(true)
  expect(calls).toBe(1)
  expect(() => services[0].register({ id: "run", title: "Duplicate", execute() {} })).toThrow("Duplicate")
  lifetimes[0].dispose()
  expect(commands.options()).toHaveLength(1)
  expect(menus.list("app.footer")).toHaveLength(1)
  await expect(services[0].execute("run")).rejects.toThrow()
  lifetimes[1].dispose()
  expect(commands.options()).toEqual([])
  expect(menus.list("app.footer")).toEqual([])
})

test("command execution checks current identity and capability", async () => {
  const lifetime = createPluginSurfaceLifetime(() => {})
  const service = createPluginSurfaceCommands({
    pluginId: "plugin",
    commands: createCommandRegistry(),
    menus: createPluginMenuRegistry(),
    lifetime: lifetime.context,
    access: createPluginSurfaceAccess({ lifetime: lifetime.context, capabilities: [], current: () => true }),
    context: () => ({}),
    reportError() {},
  })
  expect(() => service.register({ id: "run", title: "Run", execute() {} })).toThrow("ui.commands")
  await expect(service.execute("run")).rejects.toThrow("ui.commands")
  lifetime.dispose()
})
