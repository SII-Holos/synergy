import { onMount, onCleanup, createSignal, createMemo, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useServer } from "@/context/server"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import {
  type SandboxMessage,
  type SandboxResponse,
  parseSandboxMessage,
  withTimeout,
  DEFAULT_SANDBOX_TIMEOUT_MS,
} from "./postmessage-bridge"

// ── Props ────────────────────────────────────────────────────────────────────

export interface SandboxIframeProps {
  /** The plugin identifier, used for config API calls and origin validation. */
  pluginId: string
  /** The panel/surface identifier, shown in the loading state and passed to the sandbox. */
  panelId: string
  /** The URL to load in the sandboxed iframe. */
  src: string
  /** Per-request timeout in milliseconds (default 10s). */
  timeoutMs?: number
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Sandboxed iframe host for untrusted Tier 3 plugins.
 *
 * Creates an iframe with `sandbox="allow-scripts"`, validates postMessage
 * origin, and handles the full sandbox protocol: ready, getConfig, setConfig,
 * getScopeMetadata, toast, navigate, and requestPermission.
 *
 * All request/response messages are subject to a configurable timeout.
 */
export function SandboxIframe(props: SandboxIframeProps) {
  let iframeRef: HTMLIFrameElement | undefined
  const server = useServer()
  const navigate = useNavigate()
  const params = useParams()
  const timeoutMs = createMemo(() => props.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS)

  const [ready, setReady] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // ── Send a response back into the sandboxed iframe ──
  function sendToSandbox(payload: SandboxResponse) {
    iframeRef?.contentWindow?.postMessage(payload, window.location.origin)
  }

  // ── Protocol handlers ────────────────────────────────────────────────────

  async function handleGetConfig(msg: SandboxMessage & { type: "getConfig" }) {
    const url = server.url
    if (!url) {
      sendToSandbox({ type: "error", requestId: msg.requestId, message: "Server not connected", code: "NO_SERVER" })
      return
    }
    try {
      const res = await withTimeout(fetch(`${url}/plugin/${props.pluginId}/config`), timeoutMs(), "getConfig")
      if (!res.ok) {
        sendToSandbox({
          type: "error",
          requestId: msg.requestId,
          message: `Config fetch failed: ${res.status}`,
          code: "CONFIG_FETCH_ERROR",
        })
        return
      }
      const values = await res.json()
      sendToSandbox({ type: "config", requestId: msg.requestId, values })
    } catch (err) {
      sendToSandbox({
        type: "error",
        requestId: msg.requestId,
        message: err instanceof Error ? err.message : String(err),
        code: "CONFIG_ERROR",
      })
    }
  }

  async function handleSetConfig(msg: SandboxMessage & { type: "setConfig" }) {
    const url = server.url
    if (!url) {
      sendToSandbox({ type: "error", requestId: msg.requestId, message: "Server not connected", code: "NO_SERVER" })
      return
    }
    try {
      const res = await withTimeout(
        fetch(`${url}/plugin/${props.pluginId}/config`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.values),
        }),
        timeoutMs(),
        "setConfig",
      )
      if (!res.ok) {
        sendToSandbox({
          type: "error",
          requestId: msg.requestId,
          message: `Config update failed: ${res.status}`,
          code: "CONFIG_UPDATE_ERROR",
        })
        return
      }
      const values = await res.json()
      sendToSandbox({ type: "config", requestId: msg.requestId, values })
    } catch (err) {
      sendToSandbox({
        type: "error",
        requestId: msg.requestId,
        message: err instanceof Error ? err.message : String(err),
        code: "CONFIG_ERROR",
      })
    }
  }

  function handleGetScopeMetadata(msg: SandboxMessage & { type: "getScopeMetadata" }) {
    const directory = params.dir ? base64Decode(params.dir) : undefined
    sendToSandbox({
      type: "scopeMetadata",
      requestId: msg.requestId,
      metadata: {
        directory: directory ?? null,
      },
    })
  }

  function handleToast(msg: SandboxMessage & { type: "toast" }) {
    showToast({
      type: (msg.variant as "info" | "success" | "warning" | "error") ?? "info",
      title: props.pluginId,
      description: msg.message,
    })
  }

  function handleNavigate(msg: SandboxMessage & { type: "navigate" }) {
    navigate(msg.to)
  }

  async function handleRequestPermission(msg: SandboxMessage & { type: "requestPermission" }) {
    const response = await new Promise<SandboxResponse & { type: "permissionResult" }>((resolve) => {
      showToast({
        persistent: true,
        type: "warning",
        icon: "shield-alert",
        title: "Permission requested",
        description: `${props.pluginId} requests "${msg.permission}" for ${msg.patterns.join(", ")}`,
        actions: [
          {
            label: "Approve",
            onClick: () => resolve({ type: "permissionResult", requestId: msg.requestId, granted: true }),
          },
          {
            label: "Deny",
            onClick: () =>
              resolve({
                type: "permissionResult",
                requestId: msg.requestId,
                granted: false,
                reason: "User denied",
              }),
          },
        ],
      })
    })
    sendToSandbox(response)
  }

  // ── Message dispatch ─────────────────────────────────────────────────────

  function handleMessage(event: MessageEvent) {
    if (event.source !== iframeRef?.contentWindow) return

    // Origin validation: accept host origin and opaque sandbox origin ("null")
    if (event.origin !== window.location.origin && event.origin !== "null") return

    const msg = parseSandboxMessage(event.data)
    if (!msg) return

    switch (msg.type) {
      case "ready":
        setReady(true)
        break
      case "getConfig":
        handleGetConfig(msg)
        break
      case "setConfig":
        handleSetConfig(msg)
        break
      case "getScopeMetadata":
        handleGetScopeMetadata(msg)
        break
      case "toast":
        handleToast(msg)
        break
      case "navigate":
        handleNavigate(msg)
        break
      case "requestPermission":
        handleRequestPermission(msg)
        break
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  onMount(() => {
    window.addEventListener("message", handleMessage)
  })

  onCleanup(() => {
    window.removeEventListener("message", handleMessage)
    // Clear the iframe src to stop any ongoing loads
    if (iframeRef) {
      iframeRef.src = "about:blank"
    }
  })

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div class="sandbox-container relative w-full h-full">
      <Show when={error()}>
        <div class="flex items-center justify-center h-full text-14 text-icon-critical-base p-4">{error()}</div>
      </Show>
      <Show when={!ready() && !error()}>
        <div class="absolute inset-0 flex items-center justify-center bg-background-stronger z-10">
          <span class="text-13-regular text-text-weak">Loading {props.panelId} sandbox...</span>
        </div>
      </Show>
      <iframe
        ref={iframeRef}
        src={props.src}
        sandbox="allow-scripts"
        class="sandbox-iframe w-full h-full border-none"
        onError={() => setError("Sandbox iframe failed to load")}
      />
    </div>
  )
}
