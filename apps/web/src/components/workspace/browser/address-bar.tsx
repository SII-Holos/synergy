import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import { useLingui } from "@lingui/solid"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import {
  browserShortcut,
  type BrowserPageAction,
  type BrowserPageActionResult,
  type BrowserShortcut,
} from "@ericsanchezok/synergy-browser-core"
import { useBrowser } from "./browser-store"
import { browser as B } from "@/locales/messages"

export type AddressBarProps = {
  recent?: () => Array<{ url: string; title: string }>
  activeUrl: () => string
  isLoading: () => boolean
  hasPage: () => boolean
  onNavigate: (url: string) => void
  onHistory: (direction: "back" | "forward") => void
  onReload: () => void
  onStop: () => void
  onSettings?: () => void
  onImport?: () => void
  onPasswords?: () => void
  onNewTab?: () => void
  onCloseTab?: () => void
  onExternal?: () => void
  onScreenshot?: () => void
  onAnnotate?: () => void
  onPageAction?: (action: BrowserPageAction) => Promise<BrowserPageActionResult | undefined>
  onShortcut?: (handler: (action: BrowserShortcut) => void) => () => void
  onRequestDiagnostics: (action: "console" | "network" | "elements" | "assets" | "downloads" | "clear") => void
}

export function AddressBar(props: AddressBarProps) {
  const browser = useBrowser()
  const { _ } = useLingui()
  let root!: HTMLDivElement
  let address!: HTMLInputElement
  let optionsTrigger: HTMLButtonElement | undefined
  let findInput: HTMLInputElement | undefined
  let suggestionList: HTMLDivElement | undefined
  const suggestionID = createUniqueId()
  const modifier = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"
  const [draft, setDraft] = createSignal("")
  const [editing, setEditing] = createSignal(false)
  const [suggestionsDismissed, setSuggestionsDismissed] = createSignal(false)
  const [selectedSuggestion, setSelectedSuggestion] = createSignal(-1)
  const [submitted, setSubmitted] = createSignal<string>()
  const suggestions = createMemo(() => {
    const query = draft() === props.activeUrl() ? "" : draft().toLowerCase()
    return (props.recent?.() ?? [])
      .filter((entry) => `${entry.title} ${entry.url}`.toLowerCase().includes(query))
      .slice(0, 8)
  })
  const suggestionsOpen = () => editing() && !suggestionsDismissed() && suggestions().length > 0
  createEffect(() => {
    suggestions()
    setSelectedSuggestion(-1)
  })
  createEffect(() => browser.setAddressSuggestionsOpen(suggestionsOpen()))
  createEffect(() => {
    const selected = selectedSuggestion()
    if (selected >= 0) suggestionList?.children[selected]?.scrollIntoView({ block: "nearest" })
  })
  const [findOpen, setFindOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [matches, setMatches] = createSignal({ active: 0, matches: 0 })
  const [zoom, setZoom] = createSignal(1)
  const [history, setHistory] = createSignal({ back: false, forward: false })
  let findGeneration = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const realPage = () =>
    props.hasPage() &&
    browser.page()?.status === "active" &&
    browser.hostStatus() === "ready" &&
    Boolean(props.activeUrl()) &&
    props.activeUrl() !== "about:blank"
  const menu = (action: () => void) => {
    browser.setControlsOpen(false)
    optionsTrigger?.focus()
    action()
  }
  const navigate = (url: string) => {
    setDraft(url)
    setSubmitted(props.activeUrl())
    props.onNavigate(url)
    address.blur()
  }
  const menuKey = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), summary"),
    ).filter((item) => {
      const collapsed = item.closest("details:not([open])")
      return item.getClientRects().length > 0 && (!collapsed || item === collapsed.querySelector(":scope > summary"))
    })
    if (!items.length) return
    event.preventDefault()
    event.stopPropagation()
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % items.length
            : current < 0
              ? items.length - 1
              : (current + items.length - 1) % items.length
    items[next]?.focus()
    items[next]?.scrollIntoView({ block: "nearest" })
  }

  createEffect(() => {
    const url = props.activeUrl()
    if (!editing() && submitted() !== url) {
      setDraft(url === "about:blank" ? "" : url)
      setSubmitted(undefined)
    }
  })
  createEffect(() => {
    const pageID = browser.page()?.id
    props.activeUrl()
    let current = true
    onCleanup(() => {
      current = false
    })
    if (!realPage()) {
      setHistory({ back: false, forward: false })
      return
    }
    if (props.isLoading()) return
    void props.onPageAction?.({ type: "state" }).then((result) => {
      if (!current || browser.page()?.id !== pageID || result?.type !== "state") return
      setHistory({ back: result.back, forward: result.forward })
      setZoom(result.zoom)
    })
  })

  const focusAddress = () => {
    address.focus()
    address.select()
  }
  const openFind = () => {
    if (!realPage()) return
    setFindOpen(true)
    queueMicrotask(() => {
      findInput?.focus()
      findInput?.select()
    })
  }
  const closeFind = () => {
    findGeneration++
    clearTimeout(timer)
    setFindOpen(false)
    setQuery("")
    setMatches({ active: 0, matches: 0 })
    void props.onPageAction?.({ type: "stopFind" })
    focusAddress()
  }
  async function search(next = false, forward = true) {
    const generation = ++findGeneration
    if (!query()) {
      setMatches({ active: 0, matches: 0 })
      await props.onPageAction?.({ type: "stopFind" })
      return
    }
    const result = await props.onPageAction?.({ type: "find", text: query(), next, forward })
    if (generation === findGeneration && result?.type === "find") setMatches(result)
  }
  async function scale(factor: number) {
    const result = await props.onPageAction?.({
      type: "zoom",
      factor: Math.min(5, Math.max(0.25, Math.round(factor * 100) / 100)),
    })
    if (result?.type === "zoom") setZoom(result.factor)
  }
  function shortcut(action: BrowserShortcut) {
    if (action === "address") focusAddress()
    if (action === "find") openFind()
    if (action === "newTab") props.onNewTab?.()
    if (action === "closeTab") props.onCloseTab?.()
    if (action === "reload") props.onReload()
    if (!realPage()) return
    if (action === "print") void props.onPageAction?.({ type: "print" })
    if (action === "zoomIn") void scale(zoom() + 0.1)
    if (action === "zoomOut") void scale(zoom() - 0.1)
    if (action === "zoomReset") void scale(1)
  }
  onMount(() => {
    if (!realPage()) focusAddress()
    const remove = props.onShortcut?.(shortcut)
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !root.parentElement?.contains(event.target as Node)) return
      const action = browserShortcut(
        { key: event.key, meta: event.metaKey, control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey },
        navigator.platform.includes("Mac") ? "darwin" : "other",
      )
      if (!action) return
      event.preventDefault()
      shortcut(action)
    }
    window.addEventListener("keydown", key)
    onCleanup(() => {
      remove?.()
      window.removeEventListener("keydown", key)
    })
  })
  onCleanup(() => {
    browser.setAddressSuggestionsOpen(false)
    clearTimeout(timer)
    browser.setControlsOpen(false)
    if (findOpen()) void props.onPageAction?.({ type: "stopFind" })
  })

  return (
    <div ref={root} class="shrink-0">
      <div class="browser-address-bar">
        <Tooltip value={_(B.navBack)}>
          <IconButton
            class="browser-nav-button"
            icon={getSemanticIcon("navigation.back")}
            variant="ghost"
            aria-label={_(B.navBack)}
            disabled={!history().back}
            onClick={() => props.onHistory("back")}
          />
        </Tooltip>
        <Tooltip value={_(B.navForward)}>
          <IconButton
            class="browser-nav-button"
            icon={getSemanticIcon("navigation.forward")}
            variant="ghost"
            aria-label={_(B.navForward)}
            disabled={!history().forward}
            onClick={() => props.onHistory("forward")}
          />
        </Tooltip>
        <Tooltip value={_(props.isLoading() ? B.stop : B.reload)}>
          <IconButton
            class="browser-nav-button"
            icon={getSemanticIcon(props.isLoading() ? "action.stop" : "action.refresh")}
            variant="ghost"
            aria-label={_(props.isLoading() ? B.stop : B.reload)}
            disabled={!props.hasPage()}
            onClick={() => (props.isLoading() ? props.onStop() : props.onReload())}
          />
        </Tooltip>
        <div class="relative min-w-0 flex-1">
          <div class="browser-address-field">
            <input
              ref={address}
              role="combobox"
              aria-label={_(B.enterUrl)}
              aria-autocomplete="list"
              aria-expanded={suggestionsOpen()}
              aria-controls={suggestionsOpen() ? suggestionID : undefined}
              aria-activedescendant={
                suggestionsOpen() && selectedSuggestion() >= 0 ? `${suggestionID}-${selectedSuggestion()}` : undefined
              }
              class="browser-address-input"
              value={draft()}
              placeholder={_(B.enterUrl)}
              spellcheck={false}
              onFocus={() => {
                setEditing(true)
                setSuggestionsDismissed(false)
              }}
              onBlur={() => setEditing(false)}
              onInput={(event) => {
                setDraft(event.currentTarget.value)
                setSuggestionsDismissed(false)
              }}
              onKeyDown={(event) => {
                if (event.isComposing) return
                if (event.key === "Escape") {
                  event.preventDefault()
                  event.stopPropagation()
                  setSuggestionsDismissed(true)
                  setSelectedSuggestion(-1)
                  setSubmitted(undefined)
                  setDraft(props.activeUrl() === "about:blank" ? "" : props.activeUrl())
                  return
                }
                if ((event.key === "ArrowDown" || event.key === "ArrowUp") && suggestions().length) {
                  event.preventDefault()
                  setSuggestionsDismissed(false)
                  setSelectedSuggestion((current) =>
                    event.key === "ArrowDown"
                      ? (current + 1) % suggestions().length
                      : current < 0
                        ? suggestions().length - 1
                        : (current + suggestions().length - 1) % suggestions().length,
                  )
                  return
                }
                if (event.key !== "Enter") return
                const target = suggestionsOpen()
                  ? (suggestions()[selectedSuggestion()]?.url ?? draft().trim())
                  : draft().trim()
                if (!target) return
                event.preventDefault()
                navigate(target)
              }}
            />
            <Show when={props.onExternal}>
              <Tooltip value={_(B.openExternal)}>
                <IconButton
                  class="browser-nav-button browser-external-button"
                  icon={getSemanticIcon("action.external")}
                  variant="ghost"
                  aria-label={_(B.openExternal)}
                  disabled={!realPage()}
                  onClick={props.onExternal}
                />
              </Tooltip>
            </Show>
          </div>
          <Show when={suggestionsOpen()}>
            <div class="browser-address-suggestions" onMouseDown={(event) => event.preventDefault()}>
              <div class="browser-address-suggestions-heading">{_(B.recentAddresses)}</div>
              <div ref={suggestionList} id={suggestionID} role="listbox" aria-label={_(B.recentAddresses)}>
                <For each={suggestions()}>
                  {(entry, index) => (
                    <button
                      type="button"
                      role="option"
                      id={`${suggestionID}-${index()}`}
                      tabindex={-1}
                      aria-selected={selectedSuggestion() === index()}
                      class="browser-address-suggestion"
                      title={entry.url}
                      onMouseMove={() => setSelectedSuggestion(index())}
                      onClick={() => navigate(entry.url)}
                    >
                      <span class="browser-address-suggestion-title">{entry.title || entry.url}</span>
                      <Show when={entry.title}>
                        <span class="browser-address-suggestion-url">{entry.url}</span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>
        <Popover
          open={browser.controlsOpen()}
          onOpenChange={browser.setControlsOpen}
          placement="bottom-end"
          variant="menu"
          title={_(B.options)}
          class="browser-options-popover synergy-workbench-canvas"
          triggerAs={(triggerProps) => (
            <Tooltip value={_(B.options)} inactive={browser.controlsOpen()}>
              <IconButton
                {...triggerProps}
                ref={(element) => {
                  optionsTrigger = element
                  if (typeof triggerProps.ref === "function") triggerProps.ref(element)
                }}
                icon={getSemanticIcon("action.more")}
                class="browser-nav-button browser-options-trigger"
                variant="ghost"
                aria-label={_(B.options)}
              />
            </Tooltip>
          )}
        >
          <div class="browser-options-menu browser-workspace" onKeyDown={menuKey}>
            <div class="browser-menu-section">
              <button class="browser-menu-row" disabled={!realPage()} onClick={() => menu(openFind)}>
                <span>{_(B.find)}</span>
                <span class="browser-menu-shortcut" aria-hidden="true">
                  {`${modifier}F`}
                </span>
              </button>
              <button
                class="browser-menu-row"
                disabled={!realPage()}
                onClick={() =>
                  menu(() => {
                    void props.onPageAction?.({ type: "print" })
                  })
                }
              >
                <span>{_(B.print)}</span>
                <span class="browser-menu-shortcut" aria-hidden="true">
                  {`${modifier}P`}
                </span>
              </button>
              <button
                class="browser-menu-row"
                disabled={!realPage()}
                onClick={() =>
                  menu(() => {
                    void props.onPageAction?.({ type: "pdf" })
                  })
                }
              >
                {_(B.savePDF)}
              </button>
              <div class="browser-menu-zoom">
                <span>{_(B.zoom)}</span>
                <div class="browser-zoom-controls">
                  <button aria-label={_(B.zoomOut)} disabled={!realPage()} onClick={() => void scale(zoom() - 0.1)}>
                    −
                  </button>
                  <button
                    title={_(B.zoomReset)}
                    aria-label={_(B.zoomReset)}
                    disabled={!realPage()}
                    onClick={() => void scale(1)}
                  >
                    {Math.round(zoom() * 100)}%
                  </button>
                  <button aria-label={_(B.zoomIn)} disabled={!realPage()} onClick={() => void scale(zoom() + 0.1)}>
                    +
                  </button>
                </div>
              </div>
            </div>
            <div class="browser-menu-section">
              <Show when={props.onScreenshot}>
                <button
                  class="browser-menu-row"
                  disabled={!realPage()}
                  onClick={() => menu(() => props.onScreenshot?.())}
                >
                  {_(B.screenshot)}
                </button>
              </Show>
              <Show when={props.onImport}>
                <button class="browser-menu-row" onClick={() => menu(() => props.onImport?.())}>
                  {_(B.importData)}
                </button>
              </Show>
              <button
                class="browser-menu-row"
                onClick={() =>
                  menu(() => {
                    browser.toggleDevPanel("downloads")
                    props.onRequestDiagnostics("downloads")
                  })
                }
              >
                {_(B.devDownloads)}
              </button>
              <Show when={props.onPasswords}>
                <button class="browser-menu-row" onClick={() => menu(() => props.onPasswords?.())}>
                  {_(B.passwords)}
                </button>
              </Show>
            </div>
            <details class="browser-menu-section">
              <summary class="browser-menu-row">
                {_(B.developerTools)}
                <Icon name={getSemanticIcon("navigation.expand")} size="small" />
              </summary>
              <For
                each={[
                  { id: "console" as const, label: _(B.devConsole) },
                  { id: "network" as const, label: _(B.devNetwork) },
                  { id: "elements" as const, label: _(B.devElements) },
                  { id: "assets" as const, label: _(B.devAssets) },
                ]}
              >
                {(panel) => (
                  <button
                    class="browser-menu-row"
                    onClick={() =>
                      menu(() => {
                        browser.toggleDevPanel(panel.id)
                        props.onRequestDiagnostics(panel.id)
                      })
                    }
                  >
                    {panel.label}
                  </button>
                )}
              </For>
              <button class="browser-menu-row" onClick={() => menu(() => props.onRequestDiagnostics("clear"))}>
                {_(B.clearDiagnostics)}
              </button>
              <div class="browser-menu-heading">{_(B.viewport)}</div>
              <div class="browser-segment">
                <button
                  class="browser-segment-item"
                  aria-pressed={browser.viewportMode() === "fit"}
                  onClick={() =>
                    browser.setViewport(browser.viewportWidth(), browser.viewportHeight(), { mode: "fit" })
                  }
                >
                  {_(B.fit)}
                </button>
                <For
                  each={[
                    { label: _(B.presetDesktop), width: 1280, height: 720 },
                    { label: _(B.presetTablet), width: 768, height: 1024 },
                    { label: _(B.presetMobile), width: 375, height: 667 },
                  ]}
                >
                  {(preset) => (
                    <button
                      class="browser-segment-item"
                      onClick={() => browser.setViewport(preset.width, preset.height)}
                    >
                      {preset.label}
                    </button>
                  )}
                </For>
              </div>
              <button
                class="browser-menu-row"
                role="switch"
                aria-checked={browser.followAgent()}
                onClick={() => (browser.followAgent() ? browser.setFollowAgent(false) : browser.followAgentNow())}
              >
                {_(B.followAgent)}
              </button>
            </details>
            <div class="browser-menu-section">
              <button class="browser-menu-row" onClick={() => menu(() => props.onSettings?.())}>
                {_(B.settings)}
              </button>
            </div>
          </div>
        </Popover>
      </div>
      <Show when={props.isLoading()}>
        <div role="progressbar" aria-label={_(B.connecting)} class="h-0.5 animate-pulse bg-border-interactive-base" />
      </Show>
      <Show when={findOpen()}>
        <div class="browser-find-bar">
          <input
            ref={findInput}
            aria-label={_(B.find)}
            placeholder={_(B.find)}
            value={query()}
            class="min-w-0 flex-1 bg-transparent outline-none"
            onInput={(event) => {
              setQuery(event.currentTarget.value)
              clearTimeout(timer)
              timer = setTimeout(() => void search(), 120)
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                event.stopPropagation()
                closeFind()
              }
              if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault()
                void search(true, !event.shiftKey)
              }
            }}
          />
          <span class="text-text-weak" aria-live="polite">
            {matches().active}/{matches().matches}
          </span>
          <IconButton
            class="browser-nav-button"
            variant="ghost"
            icon={getSemanticIcon("navigation.back")}
            title={_(B.findPrevious)}
            disabled={!matches().matches}
            onClick={() => void search(true, false)}
          />
          <IconButton
            class="browser-nav-button"
            variant="ghost"
            icon={getSemanticIcon("navigation.forward")}
            title={_(B.findNext)}
            disabled={!matches().matches}
            onClick={() => void search(true)}
          />
          <IconButton
            class="browser-nav-button"
            variant="ghost"
            icon={getSemanticIcon("action.close")}
            title={_(B.dismiss)}
            onClick={closeFind}
          />
        </div>
      </Show>
    </div>
  )
}
