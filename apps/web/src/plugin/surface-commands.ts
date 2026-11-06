import { matchesPluginUICondition, type PluginUICommands, type PluginUILifetime } from "@ericsanchezok/synergy-plugin"
import type { createCommandRegistry } from "@/context/command-registry"
import type { createPluginMenuRegistry } from "./registries/menu-registry"
import type { createPluginSurfaceAccess } from "./surface-access"
import { pluginSurfaceId } from "./surface-id"

type ConditionContext = Parameters<typeof matchesPluginUICondition>[1]
export function createPluginSurfaceCommands(input: {
  pluginId: string
  commands: ReturnType<typeof createCommandRegistry>
  menus: ReturnType<typeof createPluginMenuRegistry>
  lifetime: PluginUILifetime
  access: ReturnType<typeof createPluginSurfaceAccess>
  context(): ConditionContext
  reportError(error: { pluginId: string; message: string }): void
}): PluginUICommands {
  return {
    register(command) {
      input.access.require("ui.commands")
      if (!/^[a-z][A-Za-z0-9._-]*$/.test(command.id)) throw new Error("Invalid plugin command ID")
      const id = pluginSurfaceId(input.pluginId, command.id)
      const read = () => {
        if (!matchesPluginUICondition(command.when, input.context())) return undefined
        return {
          id,
          title: command.title,
          description: command.description,
          category: command.category,
          keybind: command.keybind,
          disabled: !matchesPluginUICondition(command.enabledWhen, input.context()),
          onSelect: async () => {
            try {
              await input.access.run("ui.commands", command.execute)
            } catch (error) {
              if (!input.lifetime.signal.aborted)
                input.reportError({
                  pluginId: input.pluginId,
                  message: error instanceof Error ? error.message : String(error),
                })
              throw error
            }
          },
        }
      }
      const disposers = [
        input.commands.register(() => {
          const option = read()
          return option ? [option] : []
        }, id),
      ]
      try {
        for (const [index, menu] of (command.menus ?? []).entries())
          disposers.push(
            input.menus.register({
              id: `${id}:${index}`,
              location: menu.location,
              order: menu.order ?? 1000,
              option: () => (matchesPluginUICondition(menu.when, input.context()) ? read() : undefined),
              execute: () => input.commands.trigger(id),
            }),
          )
      } catch (error) {
        disposers.reverse().forEach((dispose) => dispose())
        throw error
      }
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        release()
        disposers.reverse().forEach((cleanup) => cleanup())
      }
      const release = input.lifetime.onDispose(dispose)
      return dispose
    },
    execute(id) {
      return input.access.run("ui.commands", () => input.commands.trigger(pluginSurfaceId(input.pluginId, id)))
    },
  }
}
