import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useBrowser, type DevPanel } from "./browser-store"
import { browserDebug } from "./browser-debug"

export type AddressBarProps = {
  activeUrl: () => string
  isLoading: () => boolean
  hasPage: () => boolean
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

const DEV_PANELS: { id: DevPanel; label: string; description: string }[] = [
  { id: "console", label: "Console", description: "Page logs" },
  { id: "network", label: "Network", description: "Requests" },
  { id: "elements", label: "Elements", description: "Snapshot" },
  { id: "assets", label: "Assets", description: "Page files" },
  { id: "downloads", label: "Downloads", description: "Saved files" },
]

const DEV_SERVER_URLS = [
  { label: "localhost:3000", url: "http://localhost:3000" },
  { label: "localhost:5173", url: "http://localhost:5173" },
  { label: "localhost:8080", url: "http://localhost:8080" },
] as const

function displayUrl(url: string) {
  return url && url !== "about:blank" ? url : ""
}

export function AddressBar(props: AddressBarProps) {
  let inputEl: HTMLInputElement | undefined
  const browser = useBrowser()
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [draft, setDraft] = createSignal(displayUrl(props.activeUrl()))
  const [editing, setEditing] = createSignal(false)
  const [dirty, setDirty] = createSignal(false)

  createEffect(() => {
    const next = displayUrl(props.activeUrl())
    if (editing()) return
    if (dirty() && !next) return
    setDraft(next)
    setDirty(false)
  })

  const selectedViewport = createMemo(() => {
    if (browser.viewportMode() === "fit") return "Fit"
    const current = VIEWPORT_PRESETS.find(
      (preset) => preset.width === browser.viewportWidth() && preset.height === browser.viewportHeight(),
    )
    return current?.label ?? `${browser.viewportWidth()}x${browser.viewportHeight()}`
  })

  function handleNavigate() {
    const raw = draft().trim()
    browserDebug("address.navigate", {
      raw,
      activeUrl: props.activeUrl(),
      pageId: browser.pageId(),
      connectionStatus: browser.session.connectionStatus,
      hasPage: Boolean(browser.page()),
    })
    if (!raw) {
      browserDebug("address.navigate.ignored", { reason: "empty" })
      return
    }
    setDraft(raw)
    setDirty(true)
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
    const pageId = browser.pageId()
    if (!pageId) return
    if (panel === "console") browser.send({ type: "requestConsole", pageId, maxEntries: 100 })
    if (panel === "network") browser.send({ type: "requestNetwork", pageId, maxEntries: 200 })
    if (panel === "elements") browser.send({ type: "requestSnapshot", pageId })
    if (panel === "assets") browser.send({ type: "requestAssets", pageId, maxEntries: 200 })
  }

  function toggleFollowAgent() {
    if (browser.followAgent()) browser.setFollowAgent(false)
    else browser.followAgentNow()
  }

  return (
    <div class="browser-address-bar flex h-10 shrink-0 items-center gap-2 border-b px-2">
      <div class="browser-nav-group flex shrink-0 items-center gap-0.5">
        <IconButton
          icon={getSemanticIcon("navigation.back")}
          variant="ghost"
          title="Back"
          class="browser-nav-button"
          disabled={!props.hasPage()}
          onClick={() => props.onHistory("back")}
        />
        <IconButton
          icon={getSemanticIcon("navigation.forward")}
          variant="ghost"
          title="Forward"
          class="browser-nav-button"
          disabled={!props.hasPage()}
          onClick={() => props.onHistory("forward")}
        />
        <IconButton
          icon={props.isLoading() ? getSemanticIcon("action.stop") : getSemanticIcon("action.refresh")}
          variant="ghost"
          title={props.isLoading() ? "Stop" : "Reload"}
          class="browser-nav-button"
          disabled={!props.hasPage()}
          onClick={() => (props.isLoading() ? props.onStop() : props.onReload())}
        />
      </div>

      <div class="min-w-0 flex-1">
        <input
          ref={inputEl}
          type="text"
          class="browser-address-input h-7 w-full rounded-md px-2.5 text-12 text-text-base outline-none transition-colors placeholder:text-text-weak"
          value={draft()}
          placeholder="Enter URL or search"
          onFocus={() => setEditing(true)}
          onBlur={() => {
            setEditing(false)
            if (!draft().trim()) setDirty(false)
          }}
          onInput={(event) => {
            setDraft(event.currentTarget.value)
            setDirty(true)
          }}
          onKeyDown={handleKeyDown}
        />
      </div>

      <Show when={props.isLoading()}>
        <span class="block size-2.5 shrink-0 rounded-full bg-surface-interactive-base animate-pulse" />
      </Show>

      <span
        class="browser-connection-dot size-2 shrink-0 rounded-full"
        classList={{
          "bg-icon-success-base": browser.session.connectionStatus === "connected",
          "bg-icon-warning-base": browser.session.connectionStatus === "connecting",
          "bg-icon-critical-base":
            browser.session.connectionStatus === "failed" || browser.session.connectionStatus === "error",
          "bg-text-weaker": browser.session.connectionStatus === "disconnected",
        }}
        title={browser.session.connectionStatus}
      />

      <div class="relative shrink-0">
        <IconButton
          icon={getSemanticIcon("action.more")}
          variant="ghost"
          title="Browser options"
          class="browser-nav-button"
          onClick={() => setMenuOpen((v) => !v)}
        />
        <Show when={menuOpen()}>
          <div
            class="browser-options-menu absolute right-0 top-full z-50 mt-1 w-[280px] max-w-[calc(100vw-16px)] rounded-lg border text-12"
            aria-label="Browser controls"
            onClick={() => setMenuOpen(false)}
          >
            <div class="browser-menu-section">
              <button
                type="button"
                role="switch"
                aria-checked={browser.followAgent()}
                class="browser-menu-row browser-switch-row"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleFollowAgent()
                }}
              >
                <span class="browser-menu-row-copy">
                  <span class="browser-menu-row-title">Follow agent</span>
                  <span class="browser-menu-row-description">Agent navigation</span>
                </span>
                <span class="browser-toggle" data-checked={browser.followAgent()}>
                  <span class="browser-toggle-thumb" />
                </span>
              </button>
            </div>

            <div class="browser-menu-section">
              <div class="browser-menu-heading">
                <span>Viewport</span>
                <span>{selectedViewport()}</span>
              </div>
              <div class="browser-segment" aria-label="Viewport size">
                <button
                  type="button"
                  class="browser-segment-button"
                  classList={{
                    "is-active text-text-strong": browser.viewportMode() === "fit",
                    "text-text-weak": browser.viewportMode() !== "fit",
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
                      class="browser-segment-button"
                      classList={{
                        "is-active text-text-strong": selectedViewport() === preset.label,
                        "text-text-weak": selectedViewport() !== preset.label,
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

            <div class="browser-menu-section">
              <div class="browser-menu-heading">
                <span>Panels</span>
              </div>
              <For each={DEV_PANELS}>
                {(panel) => (
                  <button
                    type="button"
                    class="browser-menu-row browser-panel-row"
                    classList={{
                      "is-active text-text-strong": browser.devPanel() === panel.id,
                    }}
                    onClick={() => requestPanel(panel.id)}
                  >
                    <span class="browser-menu-row-copy">
                      <span class="browser-menu-row-title">{panel.label}</span>
                      <span class="browser-menu-row-description">{panel.description}</span>
                    </span>
                    <Show when={browser.devPanel() === panel.id}>
                      <Icon name={getSemanticIcon("state.success")} size="small" class="browser-menu-check" />
                    </Show>
                  </button>
                )}
              </For>
              <button
                type="button"
                class="browser-menu-row"
                onClick={() => browser.send({ type: "clearLogs", pageId: browser.pageId() })}
              >
                <span class="browser-menu-row-copy">
                  <span class="browser-menu-row-title">Clear diagnostics</span>
                  <span class="browser-menu-row-description">Captured logs</span>
                </span>
              </button>
            </div>

            <div class="browser-menu-section">
              <div class="browser-menu-heading">
                <span>Open local</span>
              </div>
              <For each={DEV_SERVER_URLS}>
                {(entry) => (
                  <button
                    type="button"
                    class="browser-menu-row browser-local-row"
                    onClick={() => props.onNavigate(entry.url)}
                  >
                    <span class="browser-menu-row-title">{entry.label}</span>
                    <span class="browser-menu-row-description">Open</span>
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
