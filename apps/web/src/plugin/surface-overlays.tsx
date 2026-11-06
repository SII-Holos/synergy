import { ErrorBoundary } from "solid-js"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { PortalStyleOwner, UIStyleProvider } from "@ericsanchezok/synergy-ui/context/ui-style"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { showToast, toaster } from "@ericsanchezok/synergy-ui/toast"
import type { PluginUIOverlays, PluginUILifetime } from "@ericsanchezok/synergy-plugin"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import type { createPluginSurfaceAccess } from "./surface-access"

export function createPluginSurfaceOverlays(input: {
  pluginId: string
  lifetime: PluginUILifetime
  access: ReturnType<typeof createPluginSurfaceAccess>
  reportError(error: { pluginId: string; message: string }): void
}): PluginUIOverlays {
  const dialog = useDialog()
  const confirm = useConfirm()
  return {
    dialog(render) {
      input.access.require("ui.hostActions")
      const completed = Promise.withResolvers<void>()
      let id: string | undefined
      let closed = false
      let release: (() => void) | undefined
      const finish = () => {
        if (closed) return
        closed = true
        completed.resolve()
        release?.()
      }
      const handle = {
        closed: completed.promise,
        close() {
          if (!closed) {
            if (id) dialog.close(id)
            else finish()
          }
        },
      }
      id = dialog.push(
        () => (
          <UIStyleProvider pluginId={input.pluginId}>
            <PortalStyleOwner>
              <ErrorBoundary
                fallback={(error: unknown) => {
                  const message = error instanceof Error ? error.message : String(error)
                  input.reportError({ pluginId: input.pluginId, message })
                  return <Dialog title={input.pluginId} description={message} />
                }}
              >
                {render(handle)}
              </ErrorBoundary>
            </PortalStyleOwner>
          </UIStyleProvider>
        ),
        finish,
      )
      release = input.lifetime.onDispose(handle.close)
      return handle
    },
    confirm(options) {
      return input.access.run(
        "ui.hostActions",
        () =>
          new Promise<boolean>((resolve) => {
            let release: (() => void) | undefined
            const finish = (value: boolean) => {
              resolve(value)
              release?.()
            }
            const id = confirm.show({
              title: options.title,
              description: options.message,
              confirmLabel: options.confirmLabel ?? { id: "app.common.confirm", message: "Confirm" },
              tone: "neutral",
              onConfirm() {},
              onConfirmed: () => finish(true),
              onDismiss: () => finish(false),
            })
            release = input.lifetime.onDispose(() => confirm.close(id))
          }),
      )
    },
    notify(message, options) {
      input.access.require("ui.hostActions")
      let release: (() => void) | undefined
      const id = showToast({ title: message, type: options?.kind ?? "info", onClose: () => release?.() })
      release = input.lifetime.onDispose(() => toaster.dismiss(id))
      return release
    },
  }
}
