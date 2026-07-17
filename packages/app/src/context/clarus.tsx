/**
 * Clarus navigation provider context.
 *
 * Wires the real SDK client, global event emitter, and reconnect version
 * signal into the Clarus model.  Provides a Solid context for downstream
 * navigation-panel and task-detail consumers.
 */

import { createEffect } from "solid-js"
import type { Event } from "@ericsanchezok/synergy-sdk/client"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { createClarusModel, type ClarusModel } from "./clarus/clarus-model"
import { useGlobalSDK } from "./global-sdk"
import { useGlobalSync } from "./global-sync"
import { HOME_SCOPE_KEY } from "@/utils/scope"
type ClarusEventSource = {
  on(directory: string, handler: (event: Event) => void): () => void
}

export function listenForClarusNavigationUpdates(source: ClarusEventSource, handler: () => void): () => void {
  return source.on(HOME_SCOPE_KEY, (event) => {
    if (event.type === "clarus.navigation.updated") handler()
  })
}

export const { use: useClarus, provider: ClarusProvider } = createSimpleContext({
  name: "Clarus",
  init: (): ClarusModel => {
    const sdk = useGlobalSDK()
    const sync = useGlobalSync()

    const model = createClarusModel({
      navigation: () =>
        sdk.client.global.clarus.navigation<true>().then((res) => ({
          data: res.data,
        })),
      lookupUsers: (params) =>
        sdk.client.global.clarus.composer.lookupUsers<true>(params).then((res) => ({
          data: res.data,
        })),
      lookupProjects: (params) =>
        sdk.client.global.clarus.composer.lookupProjects<true>(params).then((res) => ({
          data: res.data,
        })),
      submit: (params) =>
        sdk.client.global.clarus.composer.submit<true>(params).then((res) => ({
          data: res.data,
        })),
      eventEmitter: {
        listen(handler) {
          return listenForClarusNavigationUpdates(sdk.event, () => {
            handler({
              type: "clarus.navigation.updated",
              properties: {},
            })
          })
        },
      },
      onReconnectVersionChange(handler) {
        createEffect(() => {
          sync.reconnectVersion()
          handler()
        })
        return () => {}
      },
    })

    return model
  },
})
