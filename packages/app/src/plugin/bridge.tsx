import { createEffect, createResource, createSignal, onCleanup, onMount } from "solid-js"
import {
  setExternalToolLookup,
  setExternalFallbackLookup,
  notifyExternalToolLoaded,
} from "@ericsanchezok/synergy-ui/message-part"
import {
  setExternalMessageSlotLookup,
  notifyExternalMessageSlotsChanged,
} from "@ericsanchezok/synergy-ui/message-slots"
import {
  notifyExternalComposerSlotsChanged,
  setExternalComposerSlotLookup,
} from "@ericsanchezok/synergy-ui/composer-slots"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useCommand } from "@/context/command"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { toolRendererRegistry } from "./registries/tool-registry"
import { getMessageSlotsByName, subscribeMessageSlots } from "./registries/message-slot-registry"
import { getComposerSlotsByName, subscribeComposerSlots } from "./registries/composer-slot-registry"
import { listUICommands, subscribeUICommands } from "./registries/ui-command-registry"
import { usePluginHost } from "./host"

// Wire up at module load time — setExternalToolLookup / setExternalFallbackLookup are non-reactive, safe to call outside a root.
setExternalToolLookup((name: string) => {
  return toolRendererRegistry.render(name)
})
setExternalFallbackLookup((name: string) => {
  return toolRendererRegistry.fallback(name)
})
setExternalMessageSlotLookup((slot) => {
  return getMessageSlotsByName(slot).map((entry) => ({
    id: entry.id,
    component: entry.component,
    loader: entry.loader,
  }))
})
setExternalComposerSlotLookup((slot) => {
  return getComposerSlotsByName(slot).map((entry) => ({
    id: entry.id,
    component: entry.component,
    loader: entry.loader,
  }))
})

export function PluginToolBridge() {
  onMount(() => {
    const dispose = toolRendererRegistry.onLoad(() => {
      notifyExternalToolLoaded()
    })
    onCleanup(dispose)
  })
  return null
}

export function PluginMessageSlotBridge() {
  onMount(() => {
    const unsubscribe = subscribeMessageSlots(() => {
      notifyExternalMessageSlotsChanged()
    })
    onCleanup(unsubscribe)
  })
  return null
}

export function PluginComposerSlotBridge() {
  onMount(() => {
    const unsubscribe = subscribeComposerSlots(() => {
      notifyExternalComposerSlotsChanged()
    })
    onCleanup(unsubscribe)
  })
  return null
}

export function PluginCommandBridge() {
  const command = useCommand()
  const server = useServer()
  const [registryVersion, setRegistryVersion] = createSignal(0)

  onCleanup(subscribeUICommands(() => setRegistryVersion((version) => version + 1)))

  command.register(() => {
    registryVersion()
    return listUICommands().map((entry) => ({
      id: entry.id,
      title: entry.label,
      description: entry.description,
      category: "Plugins",
      onSelect: async () => {
        if (!entry.loader) return
        try {
          const mod = await entry.loader()
          await mod.default({ pluginId: entry.pluginId, serverUrl: server.url ?? "" })
        } catch (error) {
          showToast({
            type: "error",
            title: "Plugin command failed",
            description: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }))
  })

  return null
}

export function PluginThemeConfigBridge() {
  const globalSDK = useGlobalSDK()
  const theme = useTheme()
  const host = usePluginHost()
  const [config] = createResource(async () => {
    const result = await globalSDK.client.config.global()
    return result.data
  })

  createEffect(() => {
    host.plugins()
    theme.themes()
    theme.setThemeId(config()?.theme ?? "")
  })

  return null
}
