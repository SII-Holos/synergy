import { createSynergyClient, type Event } from "@ericsanchezok/synergy-sdk/client"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { onCleanup } from "solid-js"
import { useGlobalSDK } from "./global-sdk"
import { usePlatform } from "./platform"
import { HOME_SCOPE_KEY, isHomeScope } from "@/utils/scope"

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: { scopeKey: string }) => {
    const platform = usePlatform()
    const globalSDK = useGlobalSDK()
    const isHome = isHomeScope(props.scopeKey)
    const sdk = createSynergyClient({
      baseUrl: globalSDK.url,
      fetch: platform.fetch,
      ...(isHome ? { scopeID: HOME_SCOPE_KEY } : { directory: props.scopeKey }),
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
      scopeID: isHome ? HOME_SCOPE_KEY : undefined,
      directory: isHome ? undefined : props.scopeKey,
      isHome,
      client: sdk,
      event: emitter,
      url: globalSDK.url,
      connected: globalSDK.connected,
    }
  },
})

export type SDKContext = ReturnType<typeof useSDK>
