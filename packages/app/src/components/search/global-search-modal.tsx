import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useGlobalSDK } from "@/context/global-sdk"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { useLingui } from "@lingui/solid"
import { useLocale } from "@/context/locale"
import { relativeTime } from "@/utils/time"
import { getScopeLabel } from "@/utils/scope"
import type { GlobalSessionSearchResponse } from "@ericsanchezok/synergy-sdk/client"
import "./global-search-modal.css"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { resolveArchivedInput } from "./global-search-utils"

type SessionItem = NonNullable<GlobalSessionSearchResponse["data"]>[number]

interface GlobalSearchModalProps {
  open: boolean
  onClose: () => void
}

function scopeLabel(itemScope: SessionItem["scope"]) {
  return getScopeLabel({ worktree: itemScope.directory, name: itemScope.name }, itemScope.directory)
}

export function GlobalSearchModal(props: GlobalSearchModalProps) {
  const { _ } = useLingui()
  const { fmt } = useLocale()
  const globalSDK = useGlobalSDK()
  const navigate = useNavigate()
  const [query, setQuery] = createSignal("")
  const [results, setResults] = createSignal<SessionItem[]>([])
  const [total, setTotal] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [selectedIdx, setSelectedIdx] = createSignal(-1)
  const [showArchived, setShowArchived] = createSignal(false)
  let inputRef: HTMLInputElement | undefined
  let containerRef: HTMLDivElement | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const archiveState = createMemo(() => {
    const parsed = resolveArchivedInput(query())
    return { search: parsed.search, includeArchived: parsed.includeArchived || showArchived() }
  })

  const fetchResults = async () => {
    if (!globalSDK.connected()) return
    setLoading(true)
    try {
      const state = archiveState()
      const res = await globalSDK.client.global.session.search({
        search: state.search || undefined,
        offset: 0,
        limit: 50,
        parentOnly: "false",
        includeArchived: state.includeArchived ? "true" : "false",
      })
      if (res.data) {
        setResults(res.data.data ?? [])
        setTotal(res.data.total ?? 0)
      }
    } catch {
      setResults([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setQuery("")
        setSelectedIdx(-1)
        setShowArchived(false)
        fetchResults()
        setTimeout(() => inputRef?.focus(), 50)
      },
    ),
  )

  const handleInput = (value: string) => {
    setQuery(value)
    setSelectedIdx(-1)
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => fetchResults(), 250)
  }

  onCleanup(() => clearTimeout(debounceTimer))

  const handleSelect = (item: SessionItem) => {
    const dir = item.scope.type === "home" ? "home" : item.scope.directory
    navigate(`/${base64Encode(dir)}/session/${item.id}`)
    props.onClose()
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    const items = results()
    if (e.key === "Escape") {
      if (query().length > 0) {
        setQuery("")
        fetchResults()
      } else {
        props.onClose()
      }
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIdx((prev) => Math.min(prev + 1, items.length - 1))
      return
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIdx((prev) => Math.max(prev - 1, -1))
      return
    }
    if (e.key === "Enter" && selectedIdx() >= 0) {
      e.preventDefault()
      const item = items[selectedIdx()]
      if (item) handleSelect(item)
    }
  }

  createEffect(() => {
    if (typeof document === "undefined") return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (props.open) props.onClose()
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  return (
    <Show when={props.open}>
      <div class="gsm-overlay" onClick={props.onClose} />
      <div ref={containerRef} class="gsm-container" onKeyDown={handleKeyDown}>
        <div class="gsm-search-bar">
          <Icon name={getSemanticIcon("action.search")} size="large" class="gsm-search-icon" />
          <input
            ref={inputRef}
            type="text"
            class="gsm-input"
            placeholder={_({ id: "app.search.sessions.placeholder", message: "Search sessions..." })}
            value={query()}
            onInput={(e) => handleInput(e.currentTarget.value)}
          />
          <Show when={loading()}>
            <div class="gsm-spinner" />
          </Show>
          <button type="button" class="gsm-close-btn" onClick={props.onClose}>
            <Icon name={getSemanticIcon("action.close")} size="small" />
          </button>
        </div>
        <div class="gsm-results">
          <Show when={!loading() && results().length === 0}>
            <div class="gsm-empty">
              <Icon name={getSemanticIcon("action.search")} size="large" class="text-icon-weak-base" />
              <span class="text-13-medium text-text-weak">
                {query().length > 0
                  ? _({
                      id: "app.search.sessions.noMatch",
                      message: 'No sessions matching "{query}"',
                      values: { query: query() },
                    })
                  : _({ id: "app.search.sessions.none", message: "No sessions found" })}
              </span>
            </div>
          </Show>
          <For each={results()}>
            {(item, index) => (
              <button
                type="button"
                classList={{
                  "gsm-item": true,
                  "is-selected": index() === selectedIdx(),
                }}
                onMouseEnter={() => setSelectedIdx(index())}
                onClick={() => handleSelect(item)}
              >
                <div class="gsm-item-icon">
                  <Icon name={getSemanticIcon("settings.commands")} size="normal" />
                </div>
                <div class="gsm-item-content">
                  <div class="gsm-item-title">
                    <Show when={item.time.archived}>
                      <span class="gsm-archived-tag">
                        [{_({ id: "app.search.sessions.archived", message: "Archived" })}]
                      </span>{" "}
                    </Show>
                    {item.title}
                  </div>
                  <div class="gsm-item-meta">
                    {scopeLabel(item.scope)}
                    <span class="gsm-item-sep">·</span>
                    {relativeTime(fmt, item.time.updated)}
                    <Show when={item.lastExchange?.user}>
                      <span class="gsm-item-sep">·</span>
                      <span class="gsm-item-preview truncate">
                        {_({
                          id: "app.search.sessions.youSaid",
                          message: "You: {text}",
                          values: { text: item.lastExchange!.user },
                        })}
                      </span>
                    </Show>
                  </div>
                </div>
              </button>
            )}
          </For>
        </div>
        <div class="gsm-footer">
          <Switch
            checked={archiveState().includeArchived}
            onChange={(value) => {
              setShowArchived(value)
              fetchResults()
            }}
          >
            {_({ id: "app.search.sessions.includeArchived", message: "Include archived" })}
          </Switch>
          <Show when={total() > 0}>
            <span class="text-11-regular text-text-subtle">
              {_({
                id: "app.search.sessions.total",
                message: "{total} sessions",
                values: { total: String(total()) },
              })}
            </span>
          </Show>
        </div>
      </div>
    </Show>
  )
}
