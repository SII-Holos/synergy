import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { getScopeLabel } from "@/utils/scope"
import { resolveArchivedInput } from "./global-search-utils"
import { createSessionSearch, type SearchPage, type SearchRequest, type SearchSession } from "./session-search"
import "./global-search-modal.css"

export function SessionSearchDialog(props: {
  fetchPage: (request: SearchRequest) => Promise<SearchPage>
  formatTime: (time: number) => string
  onSelect: (session: SearchSession) => void
  onClose: () => void
}) {
  const { _ } = useLingui()
  const search = createSessionSearch(props.fetchPage)
  const [query, setQuery] = createSignal("")
  const [selectedIdx, setSelectedIdx] = createSignal(-1)
  const [showArchived, setShowArchived] = createSignal(false)
  const listID = createUniqueId()
  let list: HTMLDivElement | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  const archiveState = createMemo(() => {
    const parsed = resolveArchivedInput(query())
    return { search: parsed.search, includeArchived: parsed.includeArchived || showArchived() }
  })
  const runSearch = () => {
    clearTimeout(debounceTimer)
    setSelectedIdx(-1)
    void search.start(archiveState())
  }
  onMount(runSearch)
  onCleanup(() => clearTimeout(debounceTimer))
  const handleInput = (value: string) => {
    setQuery(value)
    setSelectedIdx(-1)
    search.invalidate()
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(runSearch, 250)
  }
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      setSelectedIdx((index) =>
        Math.max(-1, Math.min(search.results().length - 1, index + (event.key === "ArrowDown" ? 1 : -1))),
      )
      list?.querySelectorAll<HTMLElement>('[role="option"]')[selectedIdx()]?.scrollIntoView({ block: "nearest" })
    } else if (event.key === "Enter" && selectedIdx() >= 0) {
      event.preventDefault()
      const item = search.results()[selectedIdx()]
      if (item) props.onSelect(item)
    }
  }
  onMount(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return
      event.preventDefault()
      props.onClose()
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })
  return (
    <Dialog
      ariaLabel={_({ id: "app.search.sessions.title", message: "Search sessions" })}
      size="command"
      placement="top"
      class="gsm-container"
    >
      <div class="gsm-search-bar">
        <Icon name={getSemanticIcon("action.search")} size="large" class="gsm-search-icon" />
        <input
          autofocus
          type="text"
          class="gsm-input"
          role="combobox"
          aria-autocomplete="list"
          aria-label={_({ id: "app.search.sessions.title", message: "Search sessions" })}
          aria-expanded={true}
          aria-controls={listID}
          aria-activedescendant={selectedIdx() >= 0 ? `${listID}-${selectedIdx()}` : undefined}
          placeholder={_({ id: "app.search.sessions.placeholder", message: "Search sessions..." })}
          value={query()}
          onInput={(event) => handleInput(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <Show when={search.loading()}>
          <div class="gsm-spinner" aria-hidden="true" />
        </Show>
        <button
          type="button"
          class="gsm-close-btn"
          onClick={props.onClose}
          aria-label={_({ id: "app.search.sessions.close", message: "Close search" })}
        >
          <Icon name={getSemanticIcon("action.close")} size="small" />
        </button>
      </div>
      <Show when={search.loading()}>
        <div class="gsm-status" role="status">
          {_({ id: "app.search.sessions.loading", message: "Searching…" })}
        </div>
      </Show>
      <Show when={search.error()}>
        <div class="gsm-empty" role="alert">
          <Icon name={getSemanticIcon("state.warning")} size="large" />
          <span>{_({ id: "app.search.sessions.failed", message: "Search failed. Your query has been kept." })}</span>
          <Button variant="secondary" onClick={() => void search.retry()}>
            {_({ id: "app.search.sessions.retry", message: "Retry search" })}
          </Button>
        </div>
      </Show>
      <Show when={!search.loading() && !search.error() && search.results().length === 0}>
        <div class="gsm-empty" role="status">
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
      <div
        ref={list}
        id={listID}
        class="gsm-results"
        role="listbox"
        aria-busy={search.loading()}
        aria-label={_({ id: "app.search.sessions.results", message: "Search results" })}
      >
        <For each={search.results()}>
          {(item, index) => (
            <button
              type="button"
              role="option"
              id={`${listID}-${index()}`}
              aria-selected={index() === selectedIdx()}
              tabIndex={-1}
              classList={{
                "gsm-item": true,
                "is-selected": index() === selectedIdx(),
              }}
              onMouseEnter={() => setSelectedIdx(index())}
              onClick={() => props.onSelect(item)}
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
                  {getScopeLabel(item.scope)}
                  <span class="gsm-item-sep">·</span>
                  {props.formatTime(item.time.updated)}
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
      <Show when={search.moreError()}>
        <div class="gsm-status" role="alert">
          {_({
            id: "app.search.sessions.moreFailed",
            message: "Could not load more. Loaded results are still available.",
          })}
        </div>
      </Show>
      <div class="gsm-footer">
        <Switch
          checked={archiveState().includeArchived}
          onChange={(value) => {
            setShowArchived(value)
            runSearch()
          }}
        >
          {_({ id: "app.search.sessions.includeArchived", message: "Include archived" })}
        </Switch>
        <Show when={search.total() > 0}>
          <span class="text-11-regular text-text-subtle" role="status">
            {_({
              id: "app.search.sessions.loadedCount",
              message: "{loaded} of {total} sessions",
              values: { loaded: search.results().length, total: search.total() },
            })}
          </span>
        </Show>
        <Show when={search.hasMore()}>
          <Button
            variant="secondary"
            size="small"
            disabled={search.loadingMore()}
            onClick={() => void search.loadMore()}
          >
            {search.loadingMore()
              ? _({ id: "app.search.sessions.loadingMore", message: "Loading more…" })
              : search.moreError()
                ? _({ id: "app.search.sessions.retryMore", message: "Retry loading more" })
                : _({ id: "app.search.sessions.loadMore", message: "Load more" })}
          </Button>
        </Show>
      </div>
    </Dialog>
  )
}
