import { lazy, onCleanup, Suspense } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { browser as B } from "@/locales/messages"
import { usePlatform } from "@/context/platform"
import type { BrowserImportTarget, BrowserImportTargetResolver } from "./browser-import-target"
import "./browser-import-dialog.css"

const Form = lazy(() => import("./browser-import-dialog").then((module) => ({ default: module.BrowserImportForm })))
export const importPreparing = { id: "browser.import.preparing", message: "Preparing browser…" }
export const importUnavailable = {
  id: "browser.import.desktopUnavailable",
  message: "Browser import is unavailable in this Desktop window. Reopen it and try again.",
}
export const importTargetClosed = {
  id: "browser.prepare.closed",
  message: "The browser target changed or closed. Reopen the import dialog.",
}

export function BrowserImportDialog(
  props: { resolveTarget: BrowserImportTargetResolver } | { ownerKey: string; pageId: string },
) {
  const { _ } = useLingui()
  const platform = usePlatform()
  const controller = new AbortController()
  const fixed = "resolveTarget" in props ? undefined : { ownerKey: props.ownerKey, pageId: props.pageId }
  onCleanup(() => controller.abort())
  const resolveTarget: BrowserImportTargetResolver = Object.assign(
    async (signal: AbortSignal): Promise<BrowserImportTarget> => {
      if ("resolveTarget" in props) return props.resolveTarget(signal)
      const bridge = platform.browserNative
      if (!bridge?.dataAction) throw new Error(_(importUnavailable))
      const native = bridge.dataAction.bind(bridge)
      const { BROWSER_PROTOCOL_VERSION } = await import("@ericsanchezok/synergy-browser-core")
      signal.throwIfAborted()
      return {
        current: () => !signal.aborted,
        action: (action) => {
          if (action.type !== "cancelImport") signal.throwIfAborted()
          return native({
            protocolVersion: BROWSER_PROTOCOL_VERSION,
            ownerKey: fixed!.ownerKey,
            pageId: fixed!.pageId,
            action,
          })
        },
      }
    },
    { current: () => ("resolveTarget" in props ? props.resolveTarget.current() : !controller.signal.aborted) },
  )
  return (
    <Dialog
      title={_(B.importData)}
      description={_({
        id: "browser.import.hint",
        message: "Bring your saved passwords and website logins into Synergy.",
      })}
      size="form"
      class="browser-import-dialog"
    >
      <Suspense
        fallback={
          <div class="browser-import-body">
            <p role="status">{_(importPreparing)}</p>
          </div>
        }
      >
        <Form resolveTarget={resolveTarget} signal={controller.signal} />
      </Suspense>
    </Dialog>
  )
}
