import { createEffect, createResource, onCleanup, onMount } from "solid-js"
import {
  setExternalToolLookup,
  setExternalFallbackLookup,
  notifyExternalToolLoaded,
} from "@ericsanchezok/synergy-ui/message-part"
import {
  notifyExternalComposerSlotsChanged,
  setExternalComposerSlotLookup,
} from "@ericsanchezok/synergy-ui/composer-slots"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { useGlobalSDK } from "@/context/global-sdk"
import { toolRendererRegistry } from "./registries/tool-registry"
import { getComposerSlotsByName, subscribeComposerSlots } from "./registries/composer-slot-registry"
import { usePluginHost } from "./host"

// Wire up at module load time — setExternalToolLookup / setExternalFallbackLookup are non-reactive, safe to call outside a root.
setExternalToolLookup((name: string) => {
  return toolRendererRegistry.render(name)
})
setExternalFallbackLookup((name: string) => {
  return toolRendererRegistry.fallback(name)
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

export function PluginComposerSlotBridge() {
  onMount(() => {
    const unsubscribe = subscribeComposerSlots(() => {
      notifyExternalComposerSlotsChanged()
    })
    onCleanup(unsubscribe)
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
