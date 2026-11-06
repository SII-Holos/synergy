import { createEffect, onCleanup, Suspense, untrack, type ParentProps } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLingui } from "@lingui/solid"
import { workspace as W } from "@/locales/messages"
import "./mobile-workspace-dialog.css"

export function MobileWorkspaceDialog(props: ParentProps<{ onClose: () => void }>) {
  const dialog = useDialog()
  const { _ } = useLingui()
  let id: string | undefined
  let disposed = false
  createEffect(() => {
    if (id || dialog.active) return
    id = untrack(() =>
      dialog.push(
        () => (
          <Dialog ariaLabel={_(W.mobileHeader)} class="mobile-workspace-dialog">
            <div class="mobile-workbench-overlay relative flex-1 min-h-0">
              <Suspense
                fallback={
                  <div
                    class="flex h-full items-center justify-center"
                    role="progressbar"
                    aria-label={_(W.mobileHeader)}
                  >
                    <Spinner class="size-5" />
                  </div>
                }
              >
                {props.children}
              </Suspense>
            </div>
          </Dialog>
        ),
        () => {
          if (!disposed) props.onClose()
        },
      ),
    )
  })
  onCleanup(() => {
    disposed = true
    if (id) dialog.close(id)
  })
  return null
}
