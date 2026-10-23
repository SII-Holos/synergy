import { createMediaQuery } from "@solid-primitives/media"
import { createEffect, createSignal, on, onCleanup, type ParentProps } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import "./mobile-drawer.css"

export function MobileDrawerDialog(
  props: ParentProps<{ open: boolean; label: string; onClose: () => void; onClosed: () => void }>,
) {
  const dialog = useDialog()
  const desktop = createMediaQuery("(min-width: 768px)")
  const [closing, setClosing] = createSignal(false)
  let body: HTMLDivElement | undefined
  let id: string | undefined
  let disposed = false
  let revision = 0
  createEffect(
    on(
      () => [props.open, desktop()] as const,
      ([open, wide]) => {
        const current = ++revision
        if (wide) {
          if (id) dialog.close(id)
          if (open) props.onClose()
          return
        }
        if (open) {
          setClosing(false)
          if (id) return
          id = dialog.push(
            () => (
              <Dialog
                ariaLabel={props.label}
                class="mobile-drawer-overlay"
                classList={{ "mobile-drawer-closing": closing() }}
                onCloseRequest={props.onClose}
              >
                <div ref={body} class="mobile-drawer-content">
                  {props.children}
                </div>
              </Dialog>
            ),
            () => {
              id = undefined
              if (disposed) return
              props.onClose()
              props.onClosed()
            },
          )
          return
        }
        if (!id) return
        setClosing(true)
        queueMicrotask(() => {
          if (disposed || revision !== current) return
          const content = body?.closest('[data-slot="dialog-content"]')
          const overlay = content?.closest('[data-component="dialog"]')?.previousElementSibling
          const animations = [...(content?.getAnimations() ?? []), ...(overlay?.getAnimations() ?? [])]
          void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
            if (!disposed && revision === current && id) dialog.close(id)
          })
        })
      },
    ),
  )
  onCleanup(() => {
    disposed = true
    if (id) dialog.close(id)
  })
  return null
}
