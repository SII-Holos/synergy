import { For, Show, createMemo, createSignal } from "solid-js"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useBrowser, type DevPanel } from "./browser-store"
import { browserDebug } from "./browser-debug"

export type AddressBarProps = {
  activeUrl: () => string
  isLoading: () => boolean
  onNavigate: (url: string) => void
  onHistory: (direction: "back" | "forward") => void
  onReload: () => void
  onStop: () => void
}

const VIEWPORT_PRESETS = [
  { label: "Desktop", width: 1280, height: 720 },
  { label: "Tablet", width: 768, height: 1024 },
  { label: "Mobile", width: 375, height: 667 },
] as const

const DEV_PANELS: { id: DevPanel; label: string }[] = [
  { id: "console", label: "Console" },
  { id: "network", label: "Network" },
  { id: "elements", label: "Elements" },
  { id: "assets", label: "Assets" },
  { id: "downloads", label: "Downloads" },
]

const DEV_SERVER_URLS = [
  { label: "localhost:3000", url: "http://localhost:3000" },
  { label: "localhost:5173", url: "http://localhost:5173" },
  { label: "localhost:8080", url: "http://localhost:8080" },
] as const

export function AddressBar(props: AddressBarProps) {
  let inputEl: HTMLInputElement | undefined
  const browser = useBrowser()
  const [menuOpen, setMenuOpen] = createSignal(false)

  const selectedViewport = createMemo(() => {
    if (browser.viewportMode() === "fit") return "Fit"
    const current = VIEWPORT_PRESETS.find(
      (preset) => preset.width === browser.viewportWidth() && preset.height === browser.viewportHeight(),
    )
    return current?.label ?? `${browser.viewportWidth()}x${browser.viewportHeight()}`
  })

  function handleNavigate() {
    const raw = inputEl?.value.trim() ?? ""
    browserDebug("address.navigate", {
      raw,
      activeUrl: props.activeUrl(),
      activeTabId: browser.activeTabId(),
      connectionStatus: browser.session.connectionStatus,
      tabCount: browser.session.tabs.length,
    })
    if (!raw) {
      browserDebug("address.navigate.ignored", { reason: "empty" })
      return
    }
    props.onNavigate(raw)
    inputEl?.blur()
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      browserDebug("address.keydown.enter", { value: inputEl?.value ?? "" })
      handleNavigate()
    }
  }

  function requestPanel(panel: DevPanel) {
    browser.toggleDevPanel(panel)
    const tabId = browser.activeTabId()
    if (!tabId) return
    if (panel === "console") browser.send({ type: "requestConsole", tabId, maxEntries: 100 })
    if (panel === "network") browser.send({ type: "requestNetwork", tabId, maxEntries: 200 })
    if (panel === "elements") browser.send({ type: "requestSnapshot", tabId })
    if (panel === "assets") browser.send({ type: "requestAssets", tabId, maxEntries: 200 })
  }

  return (
    <div class="flex h-10 shrink-0 items-center gap-1.5 border-b border-border-weak-base bg-surface-raised-base px-2">
      <IconButton
        icon={getSemanticIcon("browser.back")}
        variant="ghost"
        title="Back"
        onClick={() => props.onHistory("back")}
      />
      <IconButton
        icon={getSemanticIcon("browser.forward")}
        variant="ghost"
        title="Forward"
        onClick={() => props.onHistory("forward")}
      />
      <IconButton
        icon={props.isLoading() ? getSemanticIcon("browser.stop") : getSemanticIcon("browser.refresh")}
        variant="ghost"
        title={props.isLoading() ? "Stop" : "Reload"}
        classList={{ "animate-spin": props.isLoading() }}
        onClick={() => (props.isLoading() ? props.onStop() : props.onReload())}
      />

      <div class="min-w-0 flex-1">
        <input
          ref={inputEl}
          type="text"
          class="h-7 w-full rounded-md border border-border-weak-base/60 bg-surface-inset-base px-2.5 text-12 text-text-base outline-none transition-colors placeholder:text-text-weak focus:border-border-strong-base"
          value={props.activeUrl()}
          placeholder="Enter URL or search"
          onKeyDown={handleKeyDown}
        />
      </div>

      <Show when={props.isLoading()}>
        <span class="block size-2.5 shrink-0 rounded-full bg-surface-interactive-base animate-pulse" />
      </Show>

      <span
        class="size-2 shrink-0 rounded-full"
        classList={{
          "bg-green-500": browser.session.connectionStatus === "connected",
          "bg-amber-500": browser.session.connectionStatus === "connecting",
          "bg-red-500": browser.session.connectionStatus === "failed" || browser.session.connectionStatus === "error",
          "bg-text-weaker": browser.session.connectionStatus === "disconnected",
        }}
        title={browser.session.connectionStatus}
      />

      <div class="relative shrink-0">
        <IconButton
          icon={getSemanticIcon("action.more")}
          variant="ghost"
          title="Browser options"
          onClick={() => setMenuOpen((v) => !v)}
        />
        <Show when={menuOpen()}>
          <div
            class="absolute right-0 top-full z-50 mt-1 w-[240px] rounded-lg border border-border-weak-base bg-surface-raised-stronger-non-alpha py-1 text-12 shadow-lg"
            onClick={() => setMenuOpen(false)}
          >
            <div class="border-b border-border-weak-base/60 px-3 py-2">
              <div class="flex items-center justify-between gap-3">
                <span class="text-text-weak">Follow agent</span>
                <button
                  type="button"
                  class="h-6 rounded px-2 text-11 transition-colors"
                  classList={{
                    "workbench-selected-surface text-text-strong": browser.followAgent(),
                    "text-text-weak hover:bg-surface-raised-base-hover hover:text-text-base": !browser.followAgent(),
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (browser.followAgent()) browser.setFollowAgent(false)
                    else browser.followAgentNow()
                  }}
                >
                  {browser.followAgent() ? "On" : "Off"}
                </button>
              </div>
            </div>

            <div class="border-b border-border-weak-base/60 px-2 py-1">
              <div class="px-1 py-1 text-11 text-text-weakest">Viewport · {selectedViewport()}</div>
              <div class="flex gap-1 px-1 pb-1">
                <button
                  type="button"
                  class="h-6 rounded px-2 text-11 transition-colors"
                  classList={{
                    "workbench-selected-surface text-text-strong": browser.viewportMode() === "fit",
                    "text-text-weak hover:bg-surface-raised-base-hover hover:text-text-base":
                      browser.viewportMode() !== "fit",
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    browser.setViewport(browser.viewportWidth(), browser.viewportHeight(), { mode: "fit" })
                  }}
                >
                  Fit
                </button>
                <For each={VIEWPORT_PRESETS}>
                  {(preset) => (
                    <button
                      type="button"
                      class="h-6 rounded px-2 text-11 transition-colors"
                      classList={{
                        "workbench-selected-surface text-text-strong": selectedViewport() === preset.label,
                        "text-text-weak hover:bg-surface-raised-base-hover hover:text-text-base":
                          selectedViewport() !== preset.label,
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        browser.setViewport(preset.width, preset.height)
                      }}
                    >
                      {preset.label}
                    </button>
                  )}
                </For>
              </div>
            </div>

            <div class="border-b border-border-weak-base/60 py-1">
              <For each={DEV_PANELS}>
                {(panel) => (
                  <button
                    type="button"
                    class="w-full px-3 py-1.5 text-left text-text-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-base"
                    classList={{
                      "bg-surface-raised-base-hover text-text-strong": browser.devPanel() === panel.id,
                    }}
                    onClick={() => requestPanel(panel.id)}
                  >
                    {panel.label}
                  </button>
                )}
              </For>
              <button
                type="button"
                class="w-full px-3 py-1.5 text-left text-text-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-base"
                onClick={() => browser.send({ type: "clearLogs", tabId: browser.activeTabId() })}
              >
                Clear diagnostics
              </button>
            </div>

            <div class="py-1">
              <For each={DEV_SERVER_URLS}>
                {(entry) => (
                  <button
                    type="button"
                    class="w-full px-3 py-1.5 text-left text-text-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-base"
                    onClick={() => props.onNavigate(entry.url)}
                  >
                    {entry.label}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
