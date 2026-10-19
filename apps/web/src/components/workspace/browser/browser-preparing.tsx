import { BrowserToolbar } from "./browser-toolbar"
import { BrowserErrorMessage } from "./browser-error-message"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
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

export function BrowserPreparingPanel(props: { tab: WorkbenchPanelTab; error?: unknown; onRetry?(): void }) {
  const workbench = useWorkbenchPanels(),
    { _ } = useLingui()
  const opening = () => workbench.openingForTab(props.tab.id)
  const openImport = useBrowserImportEntry(() => props.tab)
  const [waiting, setWaiting] = createSignal(false)
  onMount(() => {
    const timer = setTimeout(() => setWaiting(true), 800)
    onCleanup(() => clearTimeout(timer))
  })
  const requestedURL = () => {
    const state = props.tab.state
    if (!state || typeof state !== "object") return ""
    const value = ("url" in state ? state.url : undefined) ?? ("browserURL" in state ? state.browserURL : undefined)
    return typeof value === "string" && value !== "about:blank" ? value : ""
  }
  const error = () => {
    const pending = opening()
    return (
      (props.error ? normalizeBrowserError(props.error, "Browser preparation failed") : undefined) ||
      (pending?.phase === "error"
        ? normalizeBrowserError(
            pending.error,
            _({ id: "browser.prepare.failed", message: "Browser preparation failed. Retry." }),
          )
        : undefined)
    )
  }
  return (
    <div class="browser-workspace flex h-full flex-col">
      <BrowserToolbar loading={Boolean(requestedURL() && !error())}>
        <IconButton
          class="browser-nav-button"
          icon={getSemanticIcon("navigation.back")}
          variant="ghost"
          disabled
          aria-label={_(B.navBack)}
        />
        <IconButton
          class="browser-nav-button"
          icon={getSemanticIcon("navigation.forward")}
          variant="ghost"
          disabled
          aria-label={_(B.navForward)}
        />
        <IconButton
          class="browser-nav-button"
          icon={getSemanticIcon(requestedURL() ? "action.stop" : "action.refresh")}
          variant="ghost"
          disabled
          aria-label={_(requestedURL() ? B.stop : B.reload)}
        />
        <div class="relative min-w-0 flex-1">
          <div class="browser-address-field">
            <input
              class="browser-address-input"
              readOnly
              value={requestedURL()}
              aria-label={_(B.enterUrl)}
              placeholder={_(B.enterUrl)}
            />
            <IconButton
              class="browser-nav-button browser-external-button"
              icon={getSemanticIcon("action.external")}
              variant="ghost"
              disabled
              aria-label={_(B.openExternal)}
            />
          </div>
        </div>
        <IconButton
          class="browser-nav-button browser-options-trigger"
          icon={getSemanticIcon("action.more")}
          variant="ghost"
          disabled
          aria-label={_(B.options)}
        />
      </BrowserToolbar>
      <div class="relative min-h-0 flex-1">
        <Show when={!requestedURL() && !error()}>
          <BrowserNewTab pending onNavigate={() => {}} onImport={openImport} />
        </Show>
        <Show when={error() || !requestedURL() || waiting()}>
          <div class="browser-preparing-status" role={error() ? "alert" : "status"}>
            <Show
              when={error()}
              fallback={
                <span>
                  {requestedURL()
                    ? _({ id: "browser.navigation.opening", message: "Opening page…" })
                    : _(importPreparing)}
                </span>
              }
            >
              {(failure) => <BrowserErrorMessage error={failure()} />}
            </Show>
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
        </Show>
      </div>
    </div>
  )
}
