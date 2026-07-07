import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { deleteArchivedSessionConfirm } from "@/components/dialog/confirm-copy"
import { useGlobalSDK } from "@/context/global-sdk"
import { relativeTime } from "@/utils/time"
import { getScopeLabel } from "@/utils/scope"
import { SettingsEntityList, SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { GlobalSessionSearchResponse } from "@ericsanchezok/synergy-sdk/client"

type ArchivedSessionItem = NonNullable<GlobalSessionSearchResponse["data"]>[number]
type SortBy = "archived" | "scope"
type SortDir = "asc" | "desc"

const PAGE_LIMIT = 50

function scopeLabel(item: ArchivedSessionItem) {
  return getScopeLabel({ worktree: item.scope.directory, name: item.scope.name }, item.scope.directory)
}

function sessionDirectory(item: ArchivedSessionItem) {
  return item.scope.type === "home" ? "home" : item.scope.directory
}

function formatArchivedAt(value: number | undefined) {
  if (!value) return "Unknown archive time"
  return new Date(value).toLocaleString()
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return fallback
}

export function ArchivedSessionsPanel() {
  const globalSDK = useGlobalSDK()
  const confirm = useConfirm()
  const [search, setSearch] = createSignal("")
  const [sortBy, setSortBy] = createSignal<SortBy>("archived")
  const [sortDir, setSortDir] = createSignal<SortDir>("desc")
  const [offset, setOffset] = createSignal(0)
  const [items, setItems] = createSignal<ArchivedSessionItem[]>([])
  const [total, setTotal] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [deletingID, setDeletingID] = createSignal<string | undefined>()
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const hasNextPage = createMemo(() => offset() + items().length < total())
  const pageLabel = createMemo(() => {
    if (total() === 0) return "0 archived sessions"
    return `${offset() + 1}-${offset() + items().length} of ${total()}`
  })

  async function load(nextOffset = offset()) {
    if (!globalSDK.connected()) return
    setLoading(true)
    try {
      const result = await globalSDK.client.global.session.search({
        archived: "only",
        search: search().trim() || undefined,
        offset: nextOffset,
        limit: PAGE_LIMIT,
        parentOnly: "true",
        sortBy: sortBy(),
        sortDir: sortDir(),
      })
      const body = result.data
      setItems(body?.data ?? [])
      setTotal(body?.total ?? 0)
      setOffset(body?.offset ?? nextOffset)
    } catch (error) {
      setItems([])
      setTotal(0)
      showToast({
        type: "error",
        title: "Archived sessions failed to load",
        description: errorMessage(error, "Try again."),
      })
    } finally {
      setLoading(false)
    }
  }

  function scheduleSearch(value: string) {
    setSearch(value)
    setOffset(0)
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => void load(0), 250)
  }

  onCleanup(() => clearTimeout(debounceTimer))

  function updateSort(nextSortBy: SortBy, nextSortDir: SortDir) {
    setSortBy(nextSortBy)
    setSortDir(nextSortDir)
    setOffset(0)
    void load(0)
  }

  async function deleteSession(item: ArchivedSessionItem) {
    setDeletingID(item.id)
    try {
      await globalSDK.client.session.delete({ sessionID: item.id, directory: sessionDirectory(item) })
      showToast({ type: "success", title: "Archived session deleted", description: item.title || "Untitled session" })
      await load(offset())
    } finally {
      setDeletingID(undefined)
    }
  }

  function confirmDelete(item: ArchivedSessionItem) {
    confirm.show({
      ...deleteArchivedSessionConfirm(item.title),
      onConfirm: () => deleteSession(item),
    })
  }

  createEffect(() => {
    if (!globalSDK.connected()) return
    void untrack(() => load(0))
  })

  return (
    <SettingsPage
      title="Archived Sessions"
      description="Browse and permanently delete archived sessions across projects."
    >
      <SettingsSection
        title="Archive browser"
        description="Search by title, sort by project or archive time, and delete sessions that are no longer needed."
      >
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div class="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-border-weaker-base bg-surface-raised-base px-3 py-2">
              <Icon name={getSemanticIcon("action.search")} size="small" class="text-icon-weak" />
              <input
                type="search"
                class="min-w-0 flex-1 bg-transparent text-13-regular text-text-base outline-none placeholder:text-text-weaker"
                placeholder="Search archived sessions..."
                value={search()}
                onInput={(event) => scheduleSearch(event.currentTarget.value)}
              />
              <Show when={loading()}>
                <Spinner class="size-3.5" />
              </Show>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <select
                class="rounded-lg border border-border-weaker-base bg-surface-raised-base px-2.5 py-2 text-12-regular text-text-base outline-none"
                value={`${sortBy()}:${sortDir()}`}
                onChange={(event) => {
                  const [nextSortBy, nextSortDir] = event.currentTarget.value.split(":") as [SortBy, SortDir]
                  updateSort(nextSortBy, nextSortDir)
                }}
              >
                <option value="archived:desc">Archive time: newest</option>
                <option value="archived:asc">Archive time: oldest</option>
                <option value="scope:asc">Project: A-Z</option>
                <option value="scope:desc">Project: Z-A</option>
              </select>
              <Button
                type="button"
                variant="ghost"
                size="small"
                icon={getSemanticIcon("action.refresh")}
                disabled={loading()}
                onClick={() => void load(offset())}
              >
                Refresh
              </Button>
            </div>
          </div>

          <div class="flex items-center justify-between text-11-regular text-text-weak">
            <span>{pageLabel()}</span>
            <span>Permanent deletion cannot be undone.</span>
          </div>

          <SettingsEntityList
            isEmpty={!loading() && items().length === 0}
            emptyIcon={getSemanticIcon("session.archive")}
            emptyTitle={search().trim() ? "No archived sessions match your search" : "No archived sessions"}
            emptyDescription="Archived sessions will appear here after they are hidden from active lists."
          >
            <div class="flex flex-col overflow-hidden rounded-xl border border-border-weaker-base bg-surface-base/50">
              <For each={items()}>
                {(item) => (
                  <div class="flex flex-col gap-3 border-b border-border-weaker-base px-3 py-3 last:border-b-0 md:flex-row md:items-center md:justify-between">
                    <div class="min-w-0 flex items-start gap-3">
                      <div class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-raised-base text-icon-weak">
                        <Icon name={getSemanticIcon("session.archive")} size="small" />
                      </div>
                      <div class="min-w-0">
                        <div class="truncate text-13-medium text-text-base">{item.title || "Untitled session"}</div>
                        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-11-regular text-text-weak">
                          <span class="ds-inline-badge ds-inline-badge-muted">{scopeLabel(item)}</span>
                          <span>Archived {relativeTime(item.time.archived ?? item.time.updated)}</span>
                          <span title={formatArchivedAt(item.time.archived)}>
                            {formatArchivedAt(item.time.archived)}
                          </span>
                        </div>
                        <Show when={item.lastExchange?.user}>
                          <div class="mt-1 line-clamp-1 text-11-regular text-text-weaker">
                            You: {item.lastExchange!.user}
                          </div>
                        </Show>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      icon={getSemanticIcon("action.remove")}
                      disabled={deletingID() === item.id}
                      onClick={() => confirmDelete(item)}
                    >
                      {deletingID() === item.id ? "Deleting..." : "Delete permanently"}
                    </Button>
                  </div>
                )}
              </For>
            </div>
          </SettingsEntityList>

          <div class="flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="small"
              disabled={loading() || offset() === 0}
              onClick={() => void load(Math.max(0, offset() - PAGE_LIMIT))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="small"
              disabled={loading() || !hasNextPage()}
              onClick={() => void load(offset() + PAGE_LIMIT)}
            >
              Next
            </Button>
          </div>
        </div>
      </SettingsSection>
    </SettingsPage>
  )
}
