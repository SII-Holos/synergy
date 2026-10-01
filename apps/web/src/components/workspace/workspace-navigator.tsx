import { Dialog } from "@kobalte/core/dialog"
import { Show, createSignal, createMemo, createEffect, onCleanup, onMount, type ParentProps } from "solid-js"
import { useLingui } from "@lingui/solid"
import { ResizeHandle } from "@ericsanchezok/synergy-ui/resize-handle"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { workspaceNavigatorWidth } from "@/context/layout/workspace"
import "./workspace-navigator.css"

export type WorkspaceNavigatorController = { toggle: () => void; closeDrawer: () => void }

export function WorkspaceNavigator(
  props: ParentProps<{
    label: string
    open: boolean
    width: number
    onResize: (width: number) => void
    onClose: () => void
    onOpen?: () => void
    onReady?: (controller: WorkspaceNavigatorController) => void
  }>,
) {
  const lingui = useLingui()
  const [width, setWidth] = createSignal(0)
  const [drawerOpen, setDrawerOpen] = createSignal(false)
  let anchor!: HTMLSpanElement
  let returnFocus: HTMLElement | undefined
  const presentation = createMemo(() => workspaceNavigatorWidth(width(), props.width))
  const closeDrawer = () => setDrawerOpen(false)
  props.onReady?.({
    closeDrawer,
    toggle() {
      if (presentation().drawer) {
        props.onOpen?.()
        setDrawerOpen((open) => !open)
      } else if (props.open) props.onClose()
      else props.onOpen?.()
    },
  })
  createEffect(() => {
    if (!presentation().drawer || !props.open) closeDrawer()
  })
  onMount(() => {
    const resource = anchor.closest<HTMLElement>('[data-ui-part="resource-panel"]') ?? anchor.parentElement!
    const measure = () => setWidth(Number(resource.dataset.workspaceWidth) || resource.getBoundingClientRect().width)
    const observer = new ResizeObserver(measure)
    observer.observe(resource)
    measure()
    onCleanup(() => observer.disconnect())
  })
  return (
    <>
      <span ref={anchor} hidden />
      <Show when={props.open && width() > 0 && !presentation().drawer}>
        <aside
          class="workspace-navigator"
          data-workspace-navigation
          style={{ width: `${presentation().width}px` }}
          aria-label={props.label}
        >
          {props.children}
          <ResizeHandle
            direction="horizontal"
            edge="end"
            size={presentation().width}
            min={208}
            max={Math.min(420, width() - 280)}
            aria-label={lingui._({ id: "workspace.navigation.resize", message: "Resize navigation" })}
            onResize={props.onResize}
            onCollapse={props.onClose}
            collapseThreshold={180}
          />
        </aside>
      </Show>
      <Dialog
        open={drawerOpen() && props.open && width() > 0 && presentation().drawer}
        modal
        onOpenChange={(open) => {
          if (!open) closeDrawer()
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay class="workspace-navigator-overlay" data-component="dialog-overlay" />
          <Dialog.Content
            class="workspace-navigator-drawer"
            data-slot="dialog-content"
            data-workspace-navigation
            style={{ width: `${presentation().width}px` }}
            aria-label={props.label}
            onOpenAutoFocus={() => {
              returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
            }}
            onCloseAutoFocus={(event) => {
              if (returnFocus?.isConnected) {
                event.preventDefault()
                returnFocus.focus()
              }
            }}
          >
            <div class="workspace-navigator-drawer-header">
              <Dialog.Title>{props.label}</Dialog.Title>
              <IconButton
                icon={getSemanticIcon("action.close")}
                variant="ghost"
                onClick={closeDrawer}
                aria-label={lingui._({ id: "workspace.navigation.close", message: "Close navigation" })}
              />
            </div>
            {props.children}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </>
  )
}
