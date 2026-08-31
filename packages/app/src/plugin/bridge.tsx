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
import { readThemeSelection } from "./theme-selection"
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
  const [config] = createResource(async () => {
    const result = await globalSDK.client.config.global()
    return result.data
  })

  createEffect(() => {
    host.plugins()
    theme.themes()
    // A selection recorded in this UI during the current page's lifetime wins
    // over the config snapshot: selections persist through a fire-and-forget
    // PATCH, so the snapshot goes stale the moment one happens — and this
    // bridge remounts on session transitions, resetting any per-instance
    // baseline while a refetch racing that PATCH would still observe the old
    // preference. Module state survives those remounts.
    const recorded = readThemeSelection()
    if (recorded !== undefined) {
      theme.setThemeId(recorded || "synergy")
      return
    }
    const persisted = config()?.theme
    if (persisted === undefined) return
    theme.setThemeId(persisted || "synergy")
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
