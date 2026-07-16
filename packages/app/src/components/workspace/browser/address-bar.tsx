import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { Trans, useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useBrowser, type DevPanel } from "./browser-store"
import { browserDebug } from "./browser-debug"
import { browser as B } from "@/locales/messages"

export type AddressBarProps = {
  activeUrl: () => string
  isLoading: () => boolean
  hasPage: () => boolean
  onNavigate: (url: string) => void
  onHistory: (direction: "back" | "forward") => void
  onReload: () => void
  onStop: () => void
  onRequestDiagnostics: (action: "console" | "network" | "elements" | "assets" | "downloads" | "clear") => void
}

const VIEWPORT_PRESETS = [
  { label: "Desktop", width: 1280, height: 720 },
  { label: "Tablet", width: 768, height: 1024 },
  { label: "Mobile", width: 375, height: 667 },
] as const

const PRESET_I18N: Record<string, string> = {
  Desktop: B.presetDesktop.id,
  Tablet: B.presetTablet.id,
  Mobile: B.presetMobile.id,
}

type DiagnosticPanel = Exclude<DevPanel, "closed">

const DEV_PANELS: { id: DiagnosticPanel; labelId: string; labelMsg: string; descId: string; descMsg: string }[] = [
  {
    id: "console",
    labelId: B.devConsole.id,
    labelMsg: B.devConsole.message,
    descId: B.devConsoleDesc.id,
    descMsg: B.devConsoleDesc.message,
  },
  {
    id: "network",
    labelId: B.devNetwork.id,
    labelMsg: B.devNetwork.message,
    descId: B.devNetworkDesc.id,
    descMsg: B.devNetworkDesc.message,
  },
  {
    id: "elements",
    labelId: B.devElements.id,
    labelMsg: B.devElements.message,
    descId: B.devElementsDesc.id,
    descMsg: B.devElementsDesc.message,
  },
  {
    id: "assets",
    labelId: B.devAssets.id,
    labelMsg: B.devAssets.message,
    descId: B.devAssetsDesc.id,
    descMsg: B.devAssetsDesc.message,
  },
  {
    id: "downloads",
    labelId: B.devDownloads.id,
    labelMsg: B.devDownloads.message,
    descId: B.devDownloadsDesc.id,
    descMsg: B.devDownloadsDesc.message,
  },
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
  const lingui = useLingui()
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
    if (browser.viewportMode() === "fit") return lingui._(B.fit.id)
    const current = VIEWPORT_PRESETS.find(
      (preset) => preset.width === browser.viewportWidth() && preset.height === browser.viewportHeight(),
    )
    if (current) return lingui._(PRESET_I18N[current.label] ?? current.label)
    return `${browser.viewportWidth()}x${browser.viewportHeight()}`
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

  function requestPanel(panel: DiagnosticPanel) {
    browser.toggleDevPanel(panel)
    const pageId = browser.pageId()
    if (!pageId) return
    props.onRequestDiagnostics(panel)
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
          title={lingui._(B.navBack.id)}
          class="browser-nav-button"
          disabled={!props.hasPage()}
          onClick={() => props.onHistory("back")}
        />
        <IconButton
          icon={getSemanticIcon("navigation.forward")}
          variant="ghost"
          title={lingui._(B.navForward.id)}
          class="browser-nav-button"
          disabled={!props.hasPage()}
          onClick={() => props.onHistory("forward")}
        />
        <IconButton
          icon={props.isLoading() ? getSemanticIcon("action.stop") : getSemanticIcon("action.refresh")}
          variant="ghost"
          title={props.isLoading() ? lingui._(B.stop.id) : lingui._(B.reload.id)}
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
          placeholder={lingui._(B.enterUrl.id)}
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
          title={lingui._(B.options.id)}
          class="browser-nav-button"
          onClick={() => setMenuOpen((v) => !v)}
        />
        <Show when={menuOpen()}>
          <div
            class="browser-options-menu absolute right-0 top-full z-50 mt-1 w-[280px] max-w-[calc(100vw-16px)] rounded-lg border text-12"
            aria-label={lingui._(B.controls.id)}
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
                  <span class="browser-menu-row-title">
                    <Trans id={B.followAgent.id} message={B.followAgent.message} />
                  </span>
                  <span class="browser-menu-row-description">
                    <Trans id={B.agentNavigation.id} message={B.agentNavigation.message} />
                  </span>
                </span>
                <span class="browser-toggle" data-checked={browser.followAgent()}>
                  <span class="browser-toggle-thumb" />
                </span>
              </button>
            </div>

            <div class="browser-menu-section">
              <div class="browser-menu-heading">
                <span>
                  <Trans id={B.viewport.id} message={B.viewport.message} />
                </span>
                <span>{selectedViewport()}</span>
              </div>
              <div class="browser-segment" aria-label={lingui._(B.viewport.id)}>
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
                  <Trans id={B.fit.id} message={B.fit.message} />
                </button>
                <For each={VIEWPORT_PRESETS}>
                  {(preset) => (
                    <button
                      type="button"
                      class="browser-segment-button"
                      classList={{
                        "is-active text-text-strong":
                          selectedViewport() === lingui._(PRESET_I18N[preset.label] ?? preset.label),
                        "text-text-weak": selectedViewport() !== lingui._(PRESET_I18N[preset.label] ?? preset.label),
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        browser.setViewport(preset.width, preset.height)
                      }}
                    >
                      {lingui._(PRESET_I18N[preset.label] ?? preset.label)}
                    </button>
                  )}
                </For>
              </div>
            </div>

            <div class="browser-menu-section">
              <div class="browser-menu-heading">
                <span>
                  <Trans id={B.panels.id} message={B.panels.message} />
                </span>
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
                      <span class="browser-menu-row-title">
                        <Trans id={panel.labelId} message={panel.labelMsg} />
                      </span>
                      <span class="browser-menu-row-description">
                        <Trans id={panel.descId} message={panel.descMsg} />
                      </span>
                    </span>
                    <Show when={browser.devPanel() === panel.id}>
                      <Icon name={getSemanticIcon("state.success")} size="small" class="browser-menu-check" />
                    </Show>
                  </button>
                )}
              </For>
              <button type="button" class="browser-menu-row" onClick={() => props.onRequestDiagnostics("clear")}>
                <span class="browser-menu-row-copy">
                  <span class="browser-menu-row-title">
                    <Trans id={B.clearDiagnostics.id} message={B.clearDiagnostics.message} />
                  </span>
                  <span class="browser-menu-row-description">
                    <Trans id={B.capturedLogs.id} message={B.capturedLogs.message} />
                  </span>
                </span>
              </button>
            </div>

            <div class="browser-menu-section">
              <div class="browser-menu-heading">
                <span>
                  <Trans id={B.openLocal.id} message={B.openLocal.message} />
                </span>
              </div>
              <For each={DEV_SERVER_URLS}>
                {(entry) => (
                  <button
                    type="button"
                    class="browser-menu-row browser-local-row"
                    onClick={() => props.onNavigate(entry.url)}
                  >
                    <span class="browser-menu-row-title">{entry.label}</span>
                    <span class="browser-menu-row-description">
                      <Trans id={B.open.id} message={B.open.message} />
                    </span>
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
