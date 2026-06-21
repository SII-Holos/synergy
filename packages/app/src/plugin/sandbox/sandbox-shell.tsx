import { onMount, onCleanup, createSignal, Show } from "solid-js"
import type { BridgeMessage } from "./postmessage-bridge"
import { parseBridgeMessage } from "./postmessage-bridge"

interface SandboxShellProps {
  src: string
  panelId: string
  pluginId: string
  onMessage?: (msg: BridgeMessage) => void
}

export function SandboxShell(props: SandboxShellProps) {
  let iframeRef: HTMLIFrameElement | undefined
  const [ready, setReady] = createSignal(false)

  onMount(() => {
    const handler = (event: MessageEvent) => {
      if (!isValidOrigin(event.origin)) return
      const msg = parseBridgeMessage(event.data)
      if (!msg) return

      if (msg.type === "plugin.ready") {
        setReady(true)
      }
      props.onMessage?.(msg)
    }
    window.addEventListener("message", handler)
    onCleanup(() => window.removeEventListener("message", handler))
  })

  function send(msg: BridgeMessage) {
    iframeRef?.contentWindow?.postMessage(msg, "*")
  }

  return (
    <div class="sandbox-container">
      <Show when={!ready()}>
        <div class="sandbox-loading">Loading sandbox...</div>
      </Show>
      <iframe
        ref={iframeRef}
        src={props.src}
        sandbox="allow-scripts"
        class="sandbox-iframe"
        style={{ width: "100%", height: "100%", border: "none" }}
      />
    </div>
  )
}

function isValidOrigin(origin: string): boolean {
  return origin === window.location.origin
}
