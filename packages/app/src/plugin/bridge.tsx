import { onMount } from "solid-js"
import {
  setExternalToolLookup,
  setExternalFallbackLookup,
  notifyExternalToolLoaded,
} from "@ericsanchezok/synergy-ui/message-part"
import { getToolRenderer, getToolFallback, onToolLoaded } from "./registries/tool-registry"

// Wire up at module load time — setExternalToolLookup / setExternalFallbackLookup are non-reactive, safe to call outside a root.
setExternalToolLookup((name: string) => {
  return getToolRenderer(name)
})
setExternalFallbackLookup((name: string) => {
  return getToolFallback(name)
})

/**
 * Component that subscribes to onToolLoaded and notifies the UI layer
 * when a lazy-loaded plugin tool renderer becomes available.
 *
 * Must be rendered inside the SolidJS component tree so createEffect
 * inside onToolLoaded has a reactive root.
 */
export function PluginToolBridge() {
  onMount(() => {
    onToolLoaded(() => {
      notifyExternalToolLoaded()
    })
  })
  return null
}
