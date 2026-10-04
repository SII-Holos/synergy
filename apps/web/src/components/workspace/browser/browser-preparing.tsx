import { Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useWorkbenchPanels } from "@/context/workbench"
import type { WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"
import { BrowserNewTab } from "./browser-new-tab"
import { importPreparing } from "./browser-import-entry"
import { useBrowserImportEntry } from "./browser-import"
import { browser as B } from "@/locales/messages"
import { normalizeBrowserError } from "./browser-error"

export function BrowserPreparingPanel(props: { tab: WorkbenchPanelTab; error?: string; onRetry?(): void }) {
  const workbench = useWorkbenchPanels(),
    { _ } = useLingui()
  const opening = () => workbench.openingForTab(props.tab.id)
  const openImport = useBrowserImportEntry(() => props.tab)
  const error = () => {
    const pending = opening()
    return (
      props.error ||
      (pending?.phase === "error"
        ? normalizeBrowserError(
            pending.error,
            _({ id: "browser.prepare.failed", message: "Browser preparation failed. Retry." }),
          ).message
        : undefined)
    )
  }
  return (
    <div class="browser-workspace flex h-full flex-col">
      <div class="browser-address-bar">
        <IconButton
          class="browser-nav-button"
          icon={getSemanticIcon("navigation.back")}
          disabled
          aria-label={_(B.navBack)}
        />
        <IconButton
          class="browser-nav-button"
          icon={getSemanticIcon("navigation.forward")}
          disabled
          aria-label={_(B.navForward)}
        />
        <IconButton
          class="browser-nav-button"
          icon={getSemanticIcon("action.refresh")}
          disabled
          aria-label={_(B.reload)}
        />
        <div class="browser-address-field flex-1">
          <input class="browser-address-input" disabled aria-label={_(B.enterUrl)} placeholder={_(B.enterUrl)} />
        </div>
      </div>
      <div class="relative min-h-0 flex-1">
        <BrowserNewTab pending onNavigate={() => {}} onImport={openImport} />
        <div class="browser-preparing-status" role={error() ? "alert" : "status"}>
          <span>{error() || _(importPreparing)}</span>
          <Show when={error()}>
            <Button
              size="small"
              variant="ghost"
              onClick={() => (props.onRetry ? props.onRetry() : void opening()?.retry())}
            >
              {_(B.retry)}
            </Button>
          </Show>
        </div>
      </div>
    </div>
  )
}
