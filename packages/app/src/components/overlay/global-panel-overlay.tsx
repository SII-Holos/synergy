import type { JSX } from "solid-js"
import { Show, onCleanup, onMount, createSignal } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { Component } from "solid-js"
import { usePanel } from "@/context/panel"
import { useLayout } from "@/context/layout"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import "./global-panel-overlay.css"
interface GlobalPanelOverlayProps {
  panelContent: () => JSX.Element
  bare?: boolean
}

export function GlobalPanelOverlay(props: GlobalPanelOverlayProps) {
  const panel = usePanel()
  const layout = useLayout()
  const isOpen = () => !!panel.active()
  const isDesktop = () => layout.isDesktop()

  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen()) panel.close()
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  return (
    <Show when={isOpen()}>
      <div class="gpo-backdrop" onClick={() => panel.close()} />
      <div
        classList={{
          "gpo-container": true,
          "gpo-desktop": isDesktop(),
          "gpo-mobile": !isDesktop(),
        }}
      >
        <Show when={!props.bare}>
          <div class="gpo-header">
            <button type="button" class="gpo-close" onClick={() => panel.close()}>
              <Icon name="x" size="normal" />
            </button>
          </div>
        </Show>
        <div class="gpo-body">{props.panelContent()}</div>
      </div>
    </Show>
  )
}
