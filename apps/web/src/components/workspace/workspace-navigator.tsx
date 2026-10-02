import { Dialog } from "@kobalte/core/dialog"
import {
  Show,
  createSignal,
  createMemo,
  createEffect,
  createUniqueId,
  onCleanup,
  onMount,
  type ParentProps,
} from "solid-js"
import { useLingui } from "@lingui/solid"
import { ResizeHandle } from "@ericsanchezok/synergy-ui/resize-handle"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { OverlayLayerProvider } from "@ericsanchezok/synergy-ui/context/overlay-layer"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { workspaceNavigatorWidth } from "@/context/layout/workspace"
import { workspaceTabStops } from "./focus"
import "./workspace-navigator.css"

export type WorkspaceNavigatorController = {
  id: string
  opened: () => boolean
  toggle: () => void
  close: () => void
  closeDrawer: () => void
}

export function WorkspaceNavigator(
  props: ParentProps<{
    id?: string
    label: string
    header?: boolean
    open: boolean
    width: number
    onResize: (width: number) => void
    onClose: () => void
    onOpen?: () => void
    onReady?: (controller: WorkspaceNavigatorController) => void
  }>,
) {
  const lingui = useLingui()
  const dialogs = useDialog()
  const [width, setWidth] = createSignal(0)
  const [drawerOpen, setDrawerOpen] = createSignal(false)
  const [frame, setFrame] = createSignal<HTMLElement>()
  const [drawer, setDrawer] = createSignal<HTMLElement>()
  const id = props.id ?? createUniqueId()
  let anchor!: HTMLSpanElement
  let returnFocus: HTMLElement | undefined
  let restoreFocus = true
  let hostDialogID: string | undefined
  let focusHost: HTMLElement | undefined
  let measureLayout = () => {}
  const presentation = createMemo(() => workspaceNavigatorWidth(width(), props.width))
  const closeDrawer = () => setDrawerOpen(false)
  props.onReady?.({
    id,
    opened: () => props.open && width() > 0 && (!presentation().drawer || drawerOpen()),
    closeDrawer,
    close: () => (presentation().drawer ? closeDrawer() : props.onClose()),
    toggle() {
      if (presentation().drawer) {
        if (!drawerOpen()) {
          returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
          restoreFocus = true
          hostDialogID = dialogs.active?.id
        }
        props.onOpen?.()
        setDrawerOpen((open) => !open)
      } else if (props.open) props.onClose()
      else props.onOpen?.()
    },
  })
  createEffect(() => {
    if (!presentation().drawer || !props.open) closeDrawer()
  })
  createEffect(() => {
    if (drawerOpen()) measureLayout()
  })
  onMount(() => {
    focusHost = anchor.closest<HTMLElement>(".workbench-surface") ?? anchor.parentElement ?? undefined
    const resource = anchor.closest<HTMLElement>('[data-ui-part="resource-panel"]') ?? anchor.parentElement!
    const content = anchor.parentElement!
    setFrame(content)
    measureLayout = () => {
      setWidth(Number(resource.dataset.workspaceWidth) || resource.getBoundingClientRect().width)
    }
    const observer = new ResizeObserver(measureLayout)
    observer.observe(resource)
    if (content !== resource) observer.observe(content)
    window.addEventListener("resize", measureLayout)
    measureLayout()
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener("resize", measureLayout)
    })
  })
  return (
    <>
      <span ref={anchor} hidden />
      <Show when={props.open && width() > 0 && !presentation().drawer}>
        <aside
          id={id}
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
        modal={false}
        onOpenChange={(open) => {
          if (!open) closeDrawer()
        }}
      >
        <Dialog.Portal mount={frame()}>
          <Dialog.Overlay class="workspace-navigator-overlay" />
          <OverlayLayerProvider layer={drawer}>
            <Dialog.Content
              ref={setDrawer}
              id={id}
              class="workspace-navigator-drawer"
              data-workspace-navigation
              style={{
                width: `${presentation().width}px`,
              }}
              aria-label={props.label}
              onOpenAutoFocus={(event) => {
                // Cancel Kobalte's delayed default so it cannot replace a newer focus choice.
                // https://kobalte.dev/docs/core/components/dialog/#content
                event.preventDefault()
                const target = drawer()
                const active = document.activeElement
                queueMicrotask(() => {
                  if (
                    !target?.isConnected ||
                    target !== drawer() ||
                    !drawerOpen() ||
                    document.activeElement !== active ||
                    target.contains(active)
                  )
                    return
                  ;(workspaceTabStops(target)[0] ?? target).focus({ preventScroll: true })
                })
              }}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.defaultPrevented || event.key !== "Tab") return
                const modalHost = frame()?.closest('[aria-modal="true"], [data-slot="dialog-content"]')
                if (!modalHost) return
                const focusable = workspaceTabStops(modalHost)
                const index = focusable.indexOf(document.activeElement as HTMLElement)
                if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === focusable.length - 1)) {
                  event.preventDefault()
                  restoreFocus = false
                  const remaining = focusable.filter((element) => !drawer()?.contains(element))
                  closeDrawer()
                  remaining[event.shiftKey ? remaining.length - 1 : 0]?.focus({ preventScroll: true })
                }
              }}
              onInteractOutside={(event) => {
                if (dialogs.active && dialogs.active.id !== hostDialogID) {
                  event.preventDefault()
                  return
                }
                const target = event.target
                if (target instanceof Element && target.closest(`[aria-controls="${id}"]`)) {
                  event.preventDefault()
                  return
                }
                const modalHost = frame()?.closest('[aria-modal="true"], [data-slot="dialog-content"]')
                restoreFocus =
                  (target instanceof Element && target.classList.contains("workspace-navigator-overlay")) ||
                  Boolean(modalHost && target instanceof Node && !modalHost.contains(target))
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                if (!restoreFocus || (dialogs.active && dialogs.active.id !== hostDialogID)) return
                const target = [
                  returnFocus,
                  document.querySelector<HTMLElement>(`[aria-controls="${id}"]`),
                  focusHost?.querySelector<HTMLElement>("[data-workspace-navigation-toggle]"),
                ].find(
                  (element) =>
                    element?.isConnected &&
                    element.getClientRects().length > 0 &&
                    !element.closest('[inert], [aria-hidden="true"]'),
                )
                if (target) {
                  target.focus({ preventScroll: true })
                }
              }}
            >
              <Show when={props.header !== false} fallback={<Dialog.Title class="sr-only">{props.label}</Dialog.Title>}>
                <div class="workspace-navigator-drawer-header">
                  <Dialog.Title>{props.label}</Dialog.Title>
                  <IconButton
                    icon={getSemanticIcon("action.close")}
                    variant="ghost"
                    onClick={closeDrawer}
                    aria-label={lingui._({ id: "workspace.navigation.close", message: "Close navigation" })}
                  />
                </div>
              </Show>
              {props.children}
            </Dialog.Content>
          </OverlayLayerProvider>
        </Dialog.Portal>
      </Dialog>
    </>
  )
}
