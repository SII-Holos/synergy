import { createEffect, createResource, onCleanup, onMount } from "solid-js"
import {
  notifyExternalComposerSlotsChanged,
  setExternalComposerSlotLookup,
} from "@ericsanchezok/synergy-ui/composer-slots"
import {
  notifyExternalMessageSlotsChanged,
  setExternalMessageSlotLookup,
} from "@ericsanchezok/synergy-ui/message-slots"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { useGlobalSDK } from "@/context/global-sdk"
import { readThemeSelection, resetThemeSelection } from "./theme-selection"
import { getComposerSlotsByName, subscribeComposerSlots } from "./registries/composer-slot-registry"
import { usePluginHost } from "./host"
import { SelectionExtensionOutlet } from "./registries/selection-extension-registry"
import { getMessageSlots, subscribeMessageSlots } from "./registries/message-slot-registry"
import { useLocation } from "@solidjs/router"
import { PluginTextActionSurface } from "./text-action-surface"

setExternalComposerSlotLookup((slot) =>
  getComposerSlotsByName(slot).map((entry) => ({
    id: entry.id,
    component: entry.component,
    loader: entry.loader,
  })),
)

setExternalMessageSlotLookup((slot) =>
  getMessageSlots(slot).flatMap((entry) => {
    if (!entry.loader) return []
    return [
      {
        id: entry.id,
        loader: async () => {
          const loaded = await entry.loader!()
          return {
            default: (props) =>
              entry.roles && props.role && !entry.roles.includes(props.role) ? null : loaded.default(props),
          }
        },
      },
    ]
  }),
)

export function PluginComposerSlotBridge() {
  onMount(() => {
    const unsubscribe = subscribeComposerSlots(() => notifyExternalComposerSlotsChanged())
    const unsubscribeMessages = subscribeMessageSlots(() => notifyExternalMessageSlotsChanged())
    onCleanup(() => {
      unsubscribe()
      unsubscribeMessages()
    })
  })
  return null
}

export function PluginThemeConfigBridge() {
  const globalSDK = useGlobalSDK()
  const theme = useTheme()
  const host = usePluginHost()
  const [config, { refetch: refetchConfig }] = createResource(async () => {
    const result = await globalSDK.client.config.global()
    return result.data
  })

  // Guards the one-shot config refetch used to distinguish a definitively
  // removed theme from a cold-start gap whose preference still backs the
  // selection; without it, such a gap would refetch in a loop.
  let refetchedMissingTheme: string | undefined

  createEffect(() => {
    host.plugins()
    const persisted = config()?.theme
    const availableIds = new Set(theme.themes().map((choice) => choice.id))
    const serverUrl = globalSDK.url
    const recorded = readThemeSelection(serverUrl)
    if (recorded === undefined) {
      if (persisted === undefined) return
      theme.setThemeId(persisted || "synergy")
      return
    }
    if (availableIds.has(recorded.id)) {
      refetchedMissingTheme = undefined
      theme.setThemeId(recorded.id || "synergy")
      return
    }
    // The recorded selection's theme is not in the ready registry. While its
    // persistence PATCH has not completed, a differing config value is the
    // expected stale snapshot — keep replaying the selection. Once the PATCH
    // completed, the preference was authoritative server-side, so a config
    // that no longer backs the selection means the theme was definitively
    // removed (uninstall clears the preference): drop the record and let the
    // persisted preference take over, which also converges the skin caches.
    if (recorded.persisted && persisted !== undefined && persisted !== recorded.id) {
      resetThemeSelection(serverUrl)
      theme.setThemeId(persisted || "synergy")
      return
    }
    if (recorded.persisted && persisted === recorded.id && refetchedMissingTheme !== recorded.id) {
      refetchedMissingTheme = recorded.id
      void refetchConfig()
    }
    theme.setThemeId(recorded.id || "synergy")
  })

  return null
}

export function PluginTextInteractionBridge() {
  const location = useLocation()
  return (
    <>
      <SelectionExtensionOutlet mountKey={location.pathname} />
      <PluginTextActionSurface />
    </>
  )
}
