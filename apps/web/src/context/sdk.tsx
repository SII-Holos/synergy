import { createSynergyClient, type Event } from "@ericsanchezok/synergy-sdk/client"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { onCleanup } from "solid-js"
import { useGlobalSDK } from "./global-sdk"
import { useGlobalSync } from "./global-sync"
import { usePlatform } from "./platform"
import { HOME_SCOPE_KEY, isHomeScope } from "@/utils/scope"

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: { scopeKey: string }) => {
    const platform = usePlatform()
    const globalSDK = useGlobalSDK()
    const globalSync = useGlobalSync()
    const isHome = isHomeScope(props.scopeKey)
    const sdk = createSynergyClient({
      baseUrl: globalSDK.url,
      fetch: platform.fetch,
      scopeID: props.scopeKey,
      throwOnError: true,
    })

    const emitter = createGlobalEmitter<{
      [key in Event["type"]]: Extract<Event, { type: key }>
    }>()

    const unsub = globalSDK.event.on(props.scopeKey, (event) => {
      emitter.emit(event.type, event)
    })
    onCleanup(unsub)

    return {
      scopeKey: props.scopeKey,
      scopeID: props.scopeKey,
      get directory() {
        return globalSync.data.scope.find((scope) => scope.id === props.scopeKey)?.local?.directory ?? undefined
      },
      isHome,
      client: sdk,
      event: emitter,
      url: globalSDK.url,
      connected: globalSDK.connected,
    }
  },
})

export type SDKContext = ReturnType<typeof useSDK>
