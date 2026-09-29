import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { useLingui } from "@lingui/solid"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
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
  activeUrl: () => string
  isLoading: () => boolean
  hasPage: () => boolean
  onNavigate: (url: string) => void
  onHistory: (direction: "back" | "forward") => void
  onReload: () => void
  onStop: () => void
  onSettings?: () => void
  onImport?: () => void
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
  const [draft, setDraft] = createSignal("")
  const [editing, setEditing] = createSignal(false)
  const [findOpen, setFindOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [matches, setMatches] = createSignal({ active: 0, matches: 0 })
  const [zoom, setZoom] = createSignal(1)
  const [history, setHistory] = createSignal({ back: false, forward: false })
  let findGeneration = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const realPage = () => props.hasPage() && Boolean(props.activeUrl()) && props.activeUrl() !== "about:blank"
  const menu = (action: () => void) => {
    browser.setControlsOpen(false)
    optionsTrigger?.focus()
    action()
  }

  createEffect(() => {
    const url = props.activeUrl()
    if (!editing()) setDraft(url === "about:blank" ? "" : url)
  })
  createEffect(() => {
    props.activeUrl()
    if (props.isLoading() || !realPage()) return
    void props.onPageAction?.({ type: "state" }).then((result) => {
      if (result?.type !== "state") return
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
    if (action === "print") void props.onPageAction?.({ type: "print" })
    if (action === "zoomIn") void scale(zoom() + 0.1)
    if (action === "zoomOut") void scale(zoom() - 0.1)
    if (action === "zoomReset") void scale(1)
  }
  onMount(() => {
    if (!realPage()) focusAddress()
    const remove = props.onShortcut?.(shortcut)
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !root.parentElement?.contains(event.target as Node)) return
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
    clearTimeout(timer)
    browser.setControlsOpen(false)
    if (findOpen()) void props.onPageAction?.({ type: "stopFind" })
  })

  return (
    <div ref={root} class="shrink-0">
      <div class="browser-address-bar flex h-10 items-center gap-1.5 border-b px-2">
        <IconButton
          icon={getSemanticIcon("navigation.back")}
          variant="ghost"
          title={_(B.navBack)}
          disabled={!history().back}
          onClick={() => props.onHistory("back")}
        />
        <IconButton
          icon={getSemanticIcon("navigation.forward")}
          variant="ghost"
          title={_(B.navForward)}
          disabled={!history().forward}
          onClick={() => props.onHistory("forward")}
        />
        <IconButton
          icon={getSemanticIcon(props.isLoading() ? "action.stop" : "action.refresh")}
          variant="ghost"
          title={_(props.isLoading() ? B.stop : B.reload)}
          disabled={!props.hasPage()}
          onClick={() => (props.isLoading() ? props.onStop() : props.onReload())}
        />
        <input
          ref={address}
          aria-label={_(B.enterUrl)}
          class="browser-address-input h-7 min-w-0 flex-1 rounded-md px-2.5 text-12 outline-none"
          value={draft()}
          placeholder={_(B.enterUrl)}
          spellcheck={false}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(props.activeUrl() === "about:blank" ? "" : props.activeUrl())
              address.blur()
            }
            if (event.key !== "Enter" || event.isComposing || !draft().trim()) return
            event.preventDefault()
            props.onNavigate(draft().trim())
            address.blur()
          }}
        />
        <Show when={props.onExternal}>
          <IconButton
            icon={getSemanticIcon("action.external")}
            variant="ghost"
            title={_(B.openExternal)}
            disabled={!realPage()}
            onClick={props.onExternal}
          />
        </Show>
        <Popover
          open={browser.controlsOpen()}
          onOpenChange={browser.setControlsOpen}
          placement="bottom-end"
          title={_(B.options)}
          class="browser-options-popover synergy-workbench-canvas"
          triggerAs={(triggerProps) => (
            <IconButton
              {...triggerProps}
              ref={(element) => {
                optionsTrigger = element
                if (typeof triggerProps.ref === "function") triggerProps.ref(element)
              }}
              icon={getSemanticIcon("action.more")}
              variant="ghost"
              title={_(B.options)}
            />
          )}
        >
          <div class="browser-options-menu browser-workspace text-12">
            <div class="browser-menu-section">
              <button class="browser-menu-row" disabled={!realPage()} onClick={() => menu(openFind)}>
                {_(B.find)}
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
                {_(B.print)}
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
              <div class="browser-menu-row flex items-center justify-between">
                <span>{_(B.zoom)}</span>
                <div class="flex items-center gap-1">
                  <button
                    class="rounded px-2 py-1 hover:bg-surface-raised-base"
                    aria-label={_(B.zoomOut)}
                    disabled={!realPage()}
                    onClick={() => void scale(zoom() - 0.1)}
                  >
                    −
                  </button>
                  <button
                    class="rounded px-2 py-1 hover:bg-surface-raised-base"
                    title={_(B.zoomReset)}
                    disabled={!realPage()}
                    onClick={() => void scale(1)}
                  >
                    {Math.round(zoom() * 100)}%
                  </button>
                  <button
                    class="rounded px-2 py-1 hover:bg-surface-raised-base"
                    aria-label={_(B.zoomIn)}
                    disabled={!realPage()}
                    onClick={() => void scale(zoom() + 0.1)}
                  >
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
            </div>
            <details class="browser-menu-section">
              <summary class="browser-menu-row cursor-pointer">{_(B.developerTools)}</summary>
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
            <button class="browser-menu-row" onClick={() => menu(() => props.onSettings?.())}>
              {_(B.settings)}
            </button>
          </div>
        </Popover>
      </div>
      <Show when={props.isLoading()}>
        <div role="progressbar" aria-label={_(B.connecting)} class="h-0.5 animate-pulse bg-border-interactive-base" />
      </Show>
      <Show when={findOpen()}>
        <div class="flex items-center gap-2 border-b px-3 py-2 text-12">
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
              if (event.key === "Enter") {
                event.preventDefault()
                void search(true, !event.shiftKey)
              }
            }}
          />
          <span class="text-text-weak" aria-live="polite">
            {matches().active}/{matches().matches}
          </span>
          <IconButton
            icon={getSemanticIcon("navigation.back")}
            title={_(B.findPrevious)}
            disabled={!matches().matches}
            onClick={() => void search(true, false)}
          />
          <IconButton
            icon={getSemanticIcon("navigation.forward")}
            title={_(B.findNext)}
            disabled={!matches().matches}
            onClick={() => void search(true)}
          />
          <IconButton icon={getSemanticIcon("action.close")} title={_(B.dismiss)} onClick={closeFind} />
        </div>
      </Show>
    </div>
  )
}
