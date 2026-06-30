import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import type { ServerUpdateStatus } from "@ericsanchezok/synergy-sdk/client"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useGlobalSDK } from "./global-sdk"
import { usePlatform, type DesktopUpdateMode, type DesktopUpdateStatus } from "./platform"
import { useServer } from "./server"
import {
  productUpdateNotice,
  serverUpdateActionState,
  webUpdateNeedsRefresh,
  type ProductUpdateBusyAction,
  type ProductUpdateNotice,
} from "@/components/settings/panels/product-update-logic"

const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000
const STARTUP_UPDATE_CHECK_DELAY_MS = 60 * 1000
const ACTIVE_UPDATE_POLL_INTERVAL_MS = 2_000

export type { ProductUpdateNotice }

export const { use: useProductUpdate, provider: ProductUpdateProvider } = createSimpleContext({
  name: "ProductUpdate",
  init: () => {
    const platform = usePlatform()
    const globalSDK = useGlobalSDK()
    const server = useServer()

    const [desktopStatus, setDesktopStatus] = createSignal<DesktopUpdateStatus | null>(null)
    const [serverStatus, setServerStatus] = createSignal<ServerUpdateStatus | null>(null)
    const [serverVersion, setServerVersion] = createSignal<string | undefined>(undefined)
    const [busy, setBusy] = createSignal<ProductUpdateBusyAction>(null)
    const [serverReconnecting, setServerReconnecting] = createSignal(false)

    let hadActiveServerUpdate = false

    async function loadDesktopStatus() {
      const next = await platform.desktopUpdate?.status()
      if (next) setDesktopStatus(next)
      return next ?? null
    }

    async function refreshHealth() {
      try {
        const res = await globalSDK.client.global.health()
        setServerVersion(res.data?.version)
        return res.data ?? null
      } catch {
        return null
      }
    }

    async function refreshServerStatus(input: { check?: boolean } = {}) {
      if (platform.desktopUpdate) return null
      try {
        const statusResponse = await globalSDK.client.global.update.status()
        let next = statusResponse.data ?? null
        if (input.check && next?.capability === "managed" && serverUpdateActionState(next) !== "reconnecting") {
          const checkResponse = await globalSDK.client.global.update.check()
          next = checkResponse.data ?? next
        }
        if (next) {
          setServerStatus(next)
          const active = serverUpdateActionState(next) === "reconnecting"
          if (!active && hadActiveServerUpdate) {
            server.refresh()
            void refreshHealth()
          }
          hadActiveServerUpdate = active
          setServerReconnecting(false)
        }
        return next
      } catch {
        if (serverUpdateActionState(serverStatus()) === "reconnecting") {
          setServerReconnecting(true)
          hadActiveServerUpdate = true
        }
        return null
      }
    }

    async function refreshAll(input: { check?: boolean } = {}) {
      if (platform.desktopUpdate) {
        await loadDesktopStatus()
        return
      }
      await Promise.all([refreshHealth(), refreshServerStatus(input)])
    }

    async function run<T>(action: ProductUpdateBusyAction, fn: () => Promise<T>) {
      setBusy(action)
      try {
        return await fn()
      } finally {
        setBusy(null)
      }
    }

    async function checkNow() {
      return run("check", async () => {
        if (platform.desktopUpdate) {
          const next = await platform.desktopUpdate.check({ manual: true })
          if (next) setDesktopStatus(next)
          return
        }
        await refreshAll({ check: true })
      })
    }

    async function setDesktopMode(mode: DesktopUpdateMode) {
      return run("mode", async () => {
        const next = await platform.desktopUpdate?.setMode(mode)
        if (next) setDesktopStatus(next)
      })
    }

    async function downloadDesktopUpdate() {
      return run("download", async () => {
        const next = await platform.desktopUpdate?.download()
        if (next) setDesktopStatus(next)
      })
    }

    async function installDesktopUpdate() {
      return run("install", async () => {
        const next = await platform.desktopUpdate?.installAndRestart()
        if (next) setDesktopStatus(next)
      })
    }

    async function startServerUpdate() {
      return run("start-server", async () => {
        const response = await globalSDK.client.global.update.start({ serverUpdateStartInput: {} })
        if (response.data) {
          setServerStatus(response.data)
          hadActiveServerUpdate = serverUpdateActionState(response.data) === "reconnecting"
        }
      })
    }

    async function refreshWebClient() {
      return run("refresh", async () => {
        await platform.restart()
      })
    }

    async function runNoticeAction() {
      const action = notice().action
      if (action === "check") return checkNow()
      if (action === "download") return downloadDesktopUpdate()
      if (action === "install") return installDesktopUpdate()
      if (action === "refresh") return refreshWebClient()
      if (action === "start-server") return startServerUpdate()
    }

    if (platform.desktopUpdate) {
      void loadDesktopStatus()
      const dispose = platform.desktopUpdate.onEvent?.((event) => {
        if (event.type === "status") setDesktopStatus(event.status)
      })
      const updateTimer = setInterval(() => {
        void platform.desktopUpdate?.check({ manual: false }).then((next) => {
          if (next) setDesktopStatus(next)
        })
      }, UPDATE_CHECK_INTERVAL_MS)
      onCleanup(() => {
        dispose?.()
        clearInterval(updateTimer)
      })
    } else {
      void refreshAll()
      const startupTimer = setTimeout(() => void refreshAll({ check: true }), STARTUP_UPDATE_CHECK_DELAY_MS)
      const healthTimer = setInterval(() => void refreshAll(), HEALTH_CHECK_INTERVAL_MS)
      const updateTimer = setInterval(() => void refreshAll({ check: true }), UPDATE_CHECK_INTERVAL_MS)
      onCleanup(() => {
        clearTimeout(startupTimer)
        clearInterval(healthTimer)
        clearInterval(updateTimer)
      })
    }

    createEffect(() => {
      const active = serverUpdateActionState(serverStatus()) === "reconnecting"
      if (!active) return
      const timer = setInterval(() => void refreshAll(), ACTIVE_UPDATE_POLL_INTERVAL_MS)
      onCleanup(() => clearInterval(timer))
    })

    const webNeedsRefresh = createMemo(() => webUpdateNeedsRefresh(platform.version, serverVersion()))

    const notice = createMemo<ProductUpdateNotice>(() =>
      productUpdateNotice({
        desktopStatus: platform.desktopUpdate ? desktopStatus() : null,
        serverStatus: serverStatus(),
        appVersion: platform.version,
        serverVersion: serverVersion(),
        busy: busy(),
        serverReconnecting: serverReconnecting(),
      }),
    )

    return {
      surface: platform.desktopUpdate ? ("desktop" as const) : ("web" as const),
      appVersion: platform.version,
      serverVersion,
      desktopStatus,
      serverStatus,
      webNeedsRefresh,
      busy,
      notice,
      checkNow,
      setDesktopMode,
      downloadDesktopUpdate,
      installDesktopUpdate,
      startServerUpdate,
      refreshWebClient,
      runNoticeAction,
    }
  },
})
