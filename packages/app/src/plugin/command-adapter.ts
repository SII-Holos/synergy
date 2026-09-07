import { createRoot, type Owner } from "solid-js"
import type { PluginManifestContribution, PluginSurfaceContext } from "@ericsanchezok/synergy-plugin"

export function installPluginCommands(input: {
  contributions: readonly PluginManifestContribution[]
  owner: Owner | null
  context(): PluginSurfaceContext
}) {
  return createRoot((dispose) => {
    try {
      const context = input.context()
      for (const command of input.contributions) {
        if (command.kind !== "ui.command") continue
        context.commands.register({
          id: command.id,
          title: command.title,
          description: command.description,
          category: command.category,
          keybind: command.keybind,
          when: command.when,
          enabledWhen: command.enabledWhen,
          menus: input.contributions.flatMap((menu) =>
            menu.kind === "ui.menu" && menu.command === command.id
              ? [{ location: menu.location, order: menu.order, when: menu.when }]
              : [],
          ),
          execute: async () => {
            await context.operations.command(command.operation, command.input)
          },
        })
      }
      return dispose
    } catch (error) {
      dispose()
      throw error
    }
  }, input.owner)
}
