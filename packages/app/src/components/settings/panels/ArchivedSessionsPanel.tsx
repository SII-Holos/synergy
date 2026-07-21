import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { deleteArchivedSessionConfirm, restoreArchivedSessionConfirm } from "@/components/dialog/confirm-copy"
import { SelectionCheckbox } from "@/components/library/shared"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLocale, type IntlFormatter } from "@/context/locale"
import { relativeTime } from "@/utils/time"
import { getScopeLabel } from "@/utils/scope"
import { SettingsEntityList, SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { GlobalSessionSearchResponse } from "@ericsanchezok/synergy-sdk/client"

type ArchivedSessionItem = NonNullable<GlobalSessionSearchResponse["data"]>[number]
type SortBy = "archived" | "scope"
type SortDir = "asc" | "desc"
type BatchAction = "restore" | "delete"

const PAGE_LIMIT = 50

const loadFailedTitle = { id: "settings.archivedSessions.loadFailed", message: "Archived sessions failed to load" }
const loadFailedDesc = { id: "settings.archivedSessions.loadFailedDesc", message: "Try again." }
const restoredSingleTitle = { id: "settings.archivedSessions.restoredSingle", message: "Archived session restored" }
const restoredMultiTitle = { id: "settings.archivedSessions.restoredMulti", message: "Archived sessions restored" }
const restoreFailedSingleTitle = {
  id: "settings.archivedSessions.restoreFailedSingle",
  message: "Archived session failed to restore",
}
const restoreFailedMultiTitle = {
  id: "settings.archivedSessions.restoreFailedMulti",
  message: "Archived sessions failed to restore",
}
const deletedSingleTitle = { id: "settings.archivedSessions.deletedSingle", message: "Archived session deleted" }
const deletedMultiTitle = { id: "settings.archivedSessions.deletedMulti", message: "Archived sessions deleted" }
const deleteFailedSingleTitle = {
  id: "settings.archivedSessions.deleteFailedSingle",
  message: "Archived session failed to delete",
}
const deleteFailedMultiTitle = {
  id: "settings.archivedSessions.deleteFailedMulti",
  message: "Archived sessions failed to delete",
}
const unknownArchiveTime = { id: "settings.archivedSessions.unknownTime", message: "Unknown archive time" }

const pageTitle = { id: "settings.archivedSessions.page.title", message: "Archived Sessions" }
const pageDescription = {
  id: "settings.archivedSessions.page.description",
  message: "Browse, restore, and permanently delete archived sessions across projects.",
}
const sectionTitle = { id: "settings.archivedSessions.section.title", message: "Archive browser" }
const sectionDescription = {
  id: "settings.archivedSessions.section.description",
  message:
    "Search by title, sort by project or archive time, restore sessions, or delete sessions that are no longer needed.",
}
const searchPlaceholder = {
  id: "settings.archivedSessions.search.placeholder",
  message: "Search archived sessions...",
}
const sortNewestLabel = { id: "settings.archivedSessions.sort.newest", message: "Archive time: newest" }
const sortOldestLabel = { id: "settings.archivedSessions.sort.oldest", message: "Archive time: oldest" }
const sortProjectAZ = { id: "settings.archivedSessions.sort.projectAZ", message: "Project: A-Z" }
const sortProjectZA = { id: "settings.archivedSessions.sort.projectZA", message: "Project: Z-A" }
const refreshLabel = { id: "settings.archivedSessions.refresh", message: "Refresh" }
const selectVisibleLabel = { id: "settings.archivedSessions.select.visible", message: "Select visible" }
const selectedCountLabel = {
  id: "settings.archivedSessions.select.count",
  message: "{count} selected",
}
const restoreHint = {
  id: "settings.archivedSessions.restore.hint",
  message: "Restore keeps data; permanent deletion cannot be undone.",
}
const untitledSessionLabel = { id: "settings.archivedSessions.untitled", message: "Untitled session" }
const noResultsTitle = {
  id: "settings.archivedSessions.empty.search",
  message: "No archived sessions match your search",
}
const noResultsFallback = {
  id: "settings.archivedSessions.empty.fallback",
  message: "No archived sessions",
}
const noResultsDescription = {
  id: "settings.archivedSessions.empty.description",
  message: "Archived sessions will appear here after they are hidden from active lists.",
}
const restoreSelectedLabel = { id: "settings.archivedSessions.action.restore", message: "Restore selected" }
const restoringLabel = { id: "settings.archivedSessions.action.restoring", message: "Restoring..." }
const deleteSelectedLabel = { id: "settings.archivedSessions.action.delete", message: "Delete selected" }
const deletingLabel = { id: "settings.archivedSessions.action.deleting", message: "Deleting..." }
const previousLabel = { id: "settings.archivedSessions.pagination.previous", message: "Previous" }
const nextLabel = { id: "settings.archivedSessions.pagination.next", message: "Next" }
const singleRestoreLabel = { id: "settings.archivedSessions.action.restore.single", message: "Restore" }
const singleRestoringLabel = { id: "settings.archivedSessions.action.restoring.single", message: "Restoring..." }
const singleDeleteLabel = { id: "settings.archivedSessions.action.delete.single", message: "Delete permanently" }
const singleDeletingLabel = { id: "settings.archivedSessions.action.deleting.single", message: "Deleting..." }
const deselectLabel = { id: "settings.archivedSessions.select.deselect", message: "Deselect" }
const selectLabel = { id: "settings.archivedSessions.select.select", message: "Select" }
const archivedAtLabel = { id: "settings.archivedSessions.archivedAt", message: "Archived {time}" }
const youLabel = { id: "settings.archivedSessions.you", message: "You: {text}" }
function archivedSessionsCount(total: number) {
  return { id: "settings.archivedSessions.count", message: "{total} archived sessions", values: { total } }
}
function sessionsRestoredDesc(count: number) {
  return { id: "settings.archivedSessions.restoredDesc", message: "{count} sessions restored", values: { count } }
}
function sessionsDeletedDesc(count: number) {
  return { id: "settings.archivedSessions.deletedDesc", message: "{count} sessions deleted", values: { count } }
}

function scopeLabel(item: ArchivedSessionItem) {
  return getScopeLabel({ worktree: item.scope.directory, name: item.scope.name }, item.scope.directory)
}

function sessionDirectory(item: ArchivedSessionItem) {
  return item.scope.type === "home" ? "home" : item.scope.directory
}

function formatArchivedAt(fmt: IntlFormatter, value: number | undefined, unknownLabel: string) {
  if (!value) return unknownLabel
  return fmt.dateTime(value, { dateStyle: "medium", timeStyle: "short" })
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return fallback
}

export function ArchivedSessionsPanel() {
  const { _ } = useLingui()
  const { fmt } = useLocale()
  const globalSDK = useGlobalSDK()
  const confirm = useConfirm()
  const [search, setSearch] = createSignal("")
  const [sortBy, setSortBy] = createSignal<SortBy>("archived")
  const [sortDir, setSortDir] = createSignal<SortDir>("desc")
  const [offset, setOffset] = createSignal(0)
  const [items, setItems] = createSignal<ArchivedSessionItem[]>([])
  const [total, setTotal] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [busyID, setBusyID] = createSignal<string | undefined>()
  const [batchBusy, setBatchBusy] = createSignal<BatchAction | undefined>()
  const [selectedIDs, setSelectedIDs] = createSignal<Set<string>>(new Set())
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const selectedItems = createMemo(() => {
    const ids = selectedIDs()
    return items().filter((item) => ids.has(item.id))
  })
  const allVisibleSelected = createMemo(() => items().length > 0 && items().every((item) => selectedIDs().has(item.id)))
  const selectedCount = createMemo(() => selectedIDs().size)
  const hasNextPage = createMemo(() => offset() + items().length < total())
  const pageLabel = createMemo(() => {
    if (total() === 0) return _(archivedSessionsCount(0))
    return `${offset() + 1}-${offset() + items().length} of ${total()}`
  })
  const busy = createMemo(() => loading() || !!busyID() || !!batchBusy())

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
      const nextItems = body?.data ?? []
      setItems(nextItems)
      setTotal(body?.total ?? 0)
      setOffset(body?.offset ?? nextOffset)
      const visibleIDs = new Set(nextItems.map((item) => item.id))
      setSelectedIDs((prev) => new Set([...prev].filter((id) => visibleIDs.has(id))))
    } catch (error) {
      setItems([])
      setTotal(0)
      setSelectedIDs(new Set<string>())
      showToast({
        type: "error",
        title: _(loadFailedTitle),
        description: errorMessage(error, _(loadFailedDesc)),
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

  function toggleSelected(item: ArchivedSessionItem) {
    setSelectedIDs((prev) => {
      const next = new Set(prev)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
  }

  function toggleSelectVisible() {
    if (allVisibleSelected()) {
      setSelectedIDs(new Set<string>())
      return
    }
    setSelectedIDs(new Set(items().map((item) => item.id)))
  }

  async function restoreSessions(targets: ArchivedSessionItem[]) {
    if (targets.length === 0) return
    if (targets.length === 1) setBusyID(targets[0]!.id)
    else setBatchBusy("restore")
    try {
      await Promise.all(
        targets.map((item) =>
          globalSDK.client.session.update({
            sessionID: item.id,
            directory: sessionDirectory(item),
            time: { archived: 0 },
          }),
        ),
      )
      showToast({
        type: "success",
        title: targets.length === 1 ? _(restoredSingleTitle) : _(restoredMultiTitle),
        description:
          targets.length === 1 ? targets[0]!.title || _(untitledSessionLabel) : _(sessionsRestoredDesc(targets.length)),
      })
      setSelectedIDs(new Set<string>())
      await load(offset())
    } catch (error) {
      showToast({
        type: "error",
        title: targets.length === 1 ? _(restoreFailedSingleTitle) : _(restoreFailedMultiTitle),
        description: errorMessage(error, _(loadFailedDesc)),
      })
    } finally {
      setBusyID(undefined)
      setBatchBusy(undefined)
    }
  }

  async function deleteSessions(targets: ArchivedSessionItem[]) {
    if (targets.length === 0) return
    if (targets.length === 1) setBusyID(targets[0]!.id)
    else setBatchBusy("delete")
    try {
      await Promise.all(
        targets.map((item) =>
          globalSDK.client.session.delete({ sessionID: item.id, directory: sessionDirectory(item) }),
        ),
      )
      showToast({
        type: "success",
        title: targets.length === 1 ? _(deletedSingleTitle) : _(deletedMultiTitle),
        description:
          targets.length === 1 ? targets[0]!.title || _(untitledSessionLabel) : _(sessionsDeletedDesc(targets.length)),
      })
      setSelectedIDs(new Set<string>())
      await load(offset())
    } catch (error) {
      showToast({
        type: "error",
        title: targets.length === 1 ? _(deleteFailedSingleTitle) : _(deleteFailedMultiTitle),
        description: errorMessage(error, _(loadFailedDesc)),
      })
    } finally {
      setBusyID(undefined)
      setBatchBusy(undefined)
    }
  }

  function confirmRestore(targets: ArchivedSessionItem[]) {
    confirm.show({
      ...restoreArchivedSessionConfirm(targets.length, targets[0]?.title),
      onConfirm: () => restoreSessions(targets),
    })
  }

  function confirmDelete(targets: ArchivedSessionItem[]) {
    confirm.show({
      ...deleteArchivedSessionConfirm(targets.length, targets[0]?.title),
      onConfirm: () => deleteSessions(targets),
    })
  }

  createEffect(() => {
    if (!globalSDK.connected()) return
    void untrack(() => load(0))
  })

  return (
    <SettingsPage title={_(pageTitle)} description={_(pageDescription)}>
      <SettingsSection title={_(sectionTitle)} description={_(sectionDescription)}>
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div class="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-border-weaker-base bg-surface-raised-base px-3 py-2">
              <Icon name={getSemanticIcon("action.search")} size="small" class="text-icon-weak-base" />
              <input
                type="search"
                class="settings-archive-control-text min-w-0 flex-1 bg-transparent text-text-base outline-none placeholder:text-text-weaker"
                placeholder={_(searchPlaceholder)}
                value={search()}
                onInput={(event) => scheduleSearch(event.currentTarget.value)}
              />
              <Show when={loading()}>
                <Spinner class="size-3.5" />
              </Show>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <select
                class="settings-select rounded-lg border border-border-weaker-base bg-surface-raised-base px-2.5 py-2 text-text-base outline-none"
                value={`${sortBy()}:${sortDir()}`}
                onChange={(event) => {
                  const [nextSortBy, nextSortDir] = event.currentTarget.value.split(":") as [SortBy, SortDir]
                  updateSort(nextSortBy, nextSortDir)
                }}
              >
                <option value="archived:desc">{_(sortNewestLabel)}</option>
                <option value="archived:asc">{_(sortOldestLabel)}</option>
                <option value="scope:asc">{_(sortProjectAZ)}</option>
                <option value="scope:desc">{_(sortProjectZA)}</option>
              </select>
              <Button
                type="button"
                variant="ghost"
                size="small"
                icon={getSemanticIcon("action.refresh")}
                disabled={busy()}
                onClick={() => void load(offset())}
              >
                {_(refreshLabel)}
              </Button>
            </div>
          </div>

          <div class="flex flex-col gap-2 rounded-xl border border-border-weaker-base bg-surface-base/50 px-3 py-2 md:flex-row md:items-center md:justify-between">
            <button
              type="button"
              class="settings-archive-control-label flex items-center gap-2 text-left text-text-base disabled:cursor-not-allowed disabled:opacity-50"
              disabled={items().length === 0 || busy()}
              onClick={toggleSelectVisible}
            >
              <SelectionCheckbox selected={allVisibleSelected()} />
              <span>
                {selectedCount() > 0
                  ? _({ ...selectedCountLabel, values: { count: selectedCount() } })
                  : _(selectVisibleLabel)}
              </span>
            </button>
            <div class="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="small"
                icon={getSemanticIcon("action.restore")}
                disabled={selectedCount() === 0 || busy()}
                onClick={() => confirmRestore(selectedItems())}
              >
                {batchBusy() === "restore" ? _(restoringLabel) : _(restoreSelectedLabel)}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="small"
                icon={getSemanticIcon("action.remove")}
                disabled={selectedCount() === 0 || busy()}
                onClick={() => confirmDelete(selectedItems())}
              >
                {batchBusy() === "delete" ? _(deletingLabel) : _(deleteSelectedLabel)}
              </Button>
            </div>
          </div>

          <div class="settings-archive-caption flex items-center justify-between text-text-weak">
            <span>{pageLabel()}</span>
            <span>{_(restoreHint)}</span>
          </div>

          <SettingsEntityList
            isEmpty={!loading() && items().length === 0}
            emptyIcon={getSemanticIcon("session.archive")}
            emptyTitle={search().trim() ? _(noResultsTitle) : _(noResultsFallback)}
            emptyDescription={_(noResultsDescription)}
          >
            <div class="flex flex-col overflow-hidden rounded-xl border border-border-weaker-base bg-surface-base/50">
              <For each={items()}>
                {(item) => {
                  const selected = () => selectedIDs().has(item.id)
                  return (
                    <div
                      class="flex flex-col gap-3 border-b border-border-weaker-base px-3 py-3 last:border-b-0 md:flex-row md:items-center md:justify-between"
                      classList={{ "workbench-selected-surface": selected() }}
                    >
                      <div class="min-w-0 flex items-start gap-3">
                        <button
                          type="button"
                          class="mt-0.5 shrink-0"
                          aria-label={`${selected() ? "Deselect" : "Select"} ${item.title || _(untitledSessionLabel)}`}
                          disabled={busy()}
                          onClick={() => toggleSelected(item)}
                        >
                          <SelectionCheckbox selected={selected()} />
                        </button>
                        <div class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-raised-base text-icon-weak-base">
                          <Icon name={getSemanticIcon("session.archive")} size="small" />
                        </div>
                        <div class="min-w-0">
                          <div class="settings-row-title truncate">{item.title || _(untitledSessionLabel)}</div>
                          <div class="settings-archive-caption mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-text-weak">
                            <span class="ds-inline-badge ds-inline-badge-muted">{scopeLabel(item)}</span>
                            <span>
                              {_({
                                ...archivedAtLabel,
                                values: { time: relativeTime(fmt, item.time.archived ?? item.time.updated) },
                              })}
                            </span>
                            <span title={formatArchivedAt(fmt, item.time.archived, _(unknownArchiveTime))}>
                              {formatArchivedAt(fmt, item.time.archived, _(unknownArchiveTime))}
                            </span>
                          </div>
                          <Show when={item.lastExchange?.user}>
                            <div class="settings-archive-caption mt-1 line-clamp-1 text-text-weaker">
                              {_({ ...youLabel, values: { text: item.lastExchange!.user } })}
                            </div>
                          </Show>
                        </div>
                      </div>
                      <div class="flex flex-wrap items-center gap-2 md:justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="small"
                          icon={getSemanticIcon("action.restore")}
                          disabled={busy()}
                          onClick={() => confirmRestore([item])}
                        >
                          {busyID() === item.id ? _(singleRestoringLabel) : _(singleRestoreLabel)}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="small"
                          icon={getSemanticIcon("action.remove")}
                          disabled={busy()}
                          onClick={() => confirmDelete([item])}
                        >
                          {busyID() === item.id ? _(singleDeletingLabel) : _(singleDeleteLabel)}
                        </Button>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </SettingsEntityList>

          <div class="flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="small"
              disabled={busy() || offset() === 0}
              onClick={() => void load(Math.max(0, offset() - PAGE_LIMIT))}
            >
              {_(previousLabel)}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="small"
              disabled={busy() || !hasNextPage()}
              onClick={() => void load(offset() + PAGE_LIMIT)}
            >
              {_(nextLabel)}
            </Button>
          </div>
        </div>
      </SettingsSection>
    </SettingsPage>
  )
}
