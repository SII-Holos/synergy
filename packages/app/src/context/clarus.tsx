/**
 * Clarus navigation provider context.
 *
 * Wires the real SDK client, global event emitter, and reconnect version
 * signal into the Clarus model.  Provides a Solid context for downstream
 * navigation-panel and task-detail consumers.
 */

import { createEffect } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { createClarusModel, mapContinueLocalResult, type ClarusModel } from "./clarus/clarus-model"
import { useGlobalSDK } from "./global-sdk"
import { useGlobalSync } from "./global-sync"

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
      continueLocal: (params) =>
        sdk.client.global.clarus.projects.continueLocal<true>(params).then((res) => ({
          data: mapContinueLocalResult(res.data),
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
          return sdk.event.on("global", (event) => {
            if (event.type !== "clarus.navigation.updated") return
            handler({
              type: event.type,
              properties: event.properties,
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
