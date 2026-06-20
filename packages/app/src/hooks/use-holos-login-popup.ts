import { createSignal, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

interface HolosLoginResult {
  agentId: string
  agentSecret?: string
}

interface UseHolosLoginPopupOptions {
  serverUrl: string
  onSuccess: (result: HolosLoginResult) => void | Promise<void>
  onError?: (message: string) => void
}

interface UseHolosLoginPopup {
  trigger: () => void
  connecting: Accessor<boolean>
}

export function useHolosLoginPopup(opts: UseHolosLoginPopupOptions): UseHolosLoginPopup {
  const [connecting, setConnecting] = createSignal(false)
  let cleanupRef: (() => void) | null = null
  const client = createSynergyClient({ baseUrl: opts.serverUrl })

  onCleanup(() => cleanupRef?.())

  async function trigger() {
    if (connecting()) return
    setConnecting(true)

    try {
      const callbackUrl = `${opts.serverUrl}/holos/callback`
      const res = await client.holos.login({ callbackUrl })
      const { url } = res.data!
      const popup = window.open(url, "holos-login", "width=600,height=700,popup=yes")

      if (!popup) {
        opts.onError?.("Popup blocked — please allow popups and try again.")
        setConnecting(false)
        return
      }

      const onMessage = (event: MessageEvent) => {
        const data = event.data
        if (!data || typeof data !== "object") return

        if (data.type === "holos-login-success") {
          cleanup()
          void opts.onSuccess({ agentId: data.agentId, agentSecret: data.agentSecret })
        } else if (data.type === "holos-login-failed") {
          cleanup()
          opts.onError?.(data.error || "Login failed")
        }
      }

      const pollTimer = setInterval(() => {
        if (popup.closed) cleanup()
      }, 500)

      function cleanup() {
        window.removeEventListener("message", onMessage)
        clearInterval(pollTimer)
        setConnecting(false)
        cleanupRef = null
        try {
          popup?.close()
        } catch {}
      }

      cleanupRef = cleanup
      window.addEventListener("message", onMessage)
    } catch {
      opts.onError?.("Failed to connect")
      setConnecting(false)
    }
  }

  return { trigger, connecting }
}
