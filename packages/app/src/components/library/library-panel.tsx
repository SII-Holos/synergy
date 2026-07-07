import { createMemo, createResource, createSignal, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { AppPanel } from "@/components/app-panel"
import type { MemoryStats } from "@ericsanchezok/synergy-sdk/client"
import { type View, formatBytes } from "./shared"
import { StatsView, type LibraryStatsSyncHandle } from "./stats/stats-view"
import { StatsSection, type WorkspaceStatsSyncHandle } from "@/components/stats/stats-section"
import { MemoryView } from "./memory-view"
import { ExperienceView } from "./experience-view"
import { SkillView } from "./skill-view"
import "./library-panel.css"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export function LibraryPanel() {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const params = useParams()
  const [view, setView] = createSignal<View>("stats")
  const [search, setSearch] = createSignal("")
  const [searchError, setSearchError] = createSignal(false)
  const [workspaceStatsSync, setWorkspaceStatsSync] = createSignal<WorkspaceStatsSyncHandle>()
  const [libraryStatsSync, setLibraryStatsSync] = createSignal<LibraryStatsSyncHandle>()

  const directory = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))
  const currentSession = createMemo(() => {
    const dir = directory()
    const sessionID = params.id
    if (!dir || !sessionID) return undefined
    const [store] = globalSync.ensureScopeState(dir)
    return store.session.find((session) => session.id === sessionID)
  })
  const currentSessionID = createMemo(() => currentSession()?.id)
  const currentScopeID = createMemo(() => {
    const dir = directory()
    if (!dir) return undefined
    const [store] = globalSync.ensureScopeState(dir)
    return store.scopeID || undefined
  })

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  const [debouncedSearch, setDebouncedSearch] = createSignal("")

  function onSearchInput(value: string) {
    setSearch(value)
    setSearchError(false)
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => setDebouncedSearch(value.trim()), 300)
  }

  const isSearching = () => !!debouncedSearch()

  const [stats, { refetch: refetchStats }] = createResource(async () => {
    const result = await sdk.client.library.stats()
    return result.data as MemoryStats
  })

  const memoryCount = () => stats()?.memory.count ?? 0
  const experienceCount = () => stats()?.experience.count ?? 0

  const showSearch = () => view() !== "stats"
  const navItems = createMemo(() => [
    { id: "stats", label: "Overview" },
    { id: "memory", label: memoryCount() > 0 ? `Memories ${memoryCount()}` : "Memories" },
    { id: "experience", label: experienceCount() > 0 ? `Experiences ${experienceCount()}` : "Experiences" },
    { id: "skill", label: "Skills" },
  ])
  const storageLabel = createMemo(() => {
    const snapshot = stats()
    return snapshot ? formatBytes(snapshot.dbSizeBytes) : undefined
  })
  const isSyncing = createMemo(() => Boolean(workspaceStatsSync()?.syncing() || libraryStatsSync()?.syncing()))

  async function syncAll() {
    if (isSyncing()) return
    const tasks: Array<Promise<void>> = []
    const workspace = workspaceStatsSync()
    const library = libraryStatsSync()
    if (workspace) tasks.push(Promise.resolve(workspace.sync()))
    if (library) tasks.push(Promise.resolve(library.sync()))
    if (tasks.length === 0) return
    await Promise.all(tasks)
    await refetchStats()
  }

  return (
    <AppPanel.Root class="library-workbench">
      <AppPanel.Content>
        <AppPanel.Header class="library-header">
          <div class="library-header-inner">
            <AppPanel.HeaderRow>
              <AppPanel.Title>Library</AppPanel.Title>
              <AppPanel.Actions>
                <button
                  type="button"
                  class="library-primary-action disabled:cursor-default disabled:opacity-55"
                  disabled={isSyncing()}
                  onClick={() => void syncAll()}
                >
                  {isSyncing() ? "Syncing..." : "Sync"}
                </button>
              </AppPanel.Actions>
            </AppPanel.HeaderRow>
            <div class="library-header-controls">
              <AppPanel.SegmentedNav items={navItems()} active={view()} onChange={(id) => setView(id as View)} />
              <Show when={showSearch()}>
                <div class="library-search-field">
                  <Icon name={getSemanticIcon("action.search")} size="small" class="text-icon-weak shrink-0" />
                  <input
                    type="text"
                    placeholder={
                      view() === "memory"
                        ? "Search memories..."
                        : view() === "experience"
                          ? "Search experiences..."
                          : "Search skills..."
                    }
                    class="flex-1 bg-transparent text-13-regular text-text-base placeholder:text-text-weak outline-none"
                    value={search()}
                    onInput={(e) => onSearchInput(e.currentTarget.value)}
                  />
                  <Show when={search()}>
                    <button
                      type="button"
                      aria-label="Clear search"
                      class="library-icon-button"
                      onClick={() => onSearchInput("")}
                    >
                      <Icon name={getSemanticIcon("action.close")} size="small" />
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </AppPanel.Header>
        <Show when={searchError()}>
          <div class="shrink-0 px-6 pb-1">
            <span class="text-11-regular text-text-diff-delete-base">
              Search unavailable — embedding API may not be configured
            </span>
          </div>
        </Show>
        <AppPanel.Body padding={false} class="library-body">
          <div class="library-stage">
            <Show when={view() === "stats"}>
              <div class="library-section-block">
                <div class="library-section-heading">
                  <span class="library-section-title">Usage</span>
                </div>
                <StatsSection registerSync={setWorkspaceStatsSync} />
              </div>
              <div class="library-section-block">
                <StatsView registerSync={setLibraryStatsSync} storageLabel={storageLabel()} />
              </div>
            </Show>
            <Show when={view() === "memory"}>
              <MemoryView
                sdk={sdk}
                search={debouncedSearch()}
                isSearching={isSearching()}
                setSearchError={setSearchError}
                refetchStats={refetchStats}
              />
            </Show>
            <Show when={view() === "experience"}>
              <ExperienceView
                sdk={sdk}
                search={debouncedSearch()}
                isSearching={isSearching()}
                setSearchError={setSearchError}
                refetchStats={refetchStats}
                currentScopeID={currentScopeID()}
                currentSessionID={currentSessionID()}
              />
            </Show>
            <Show when={view() === "skill"}>
              <SkillView sdk={sdk} search={debouncedSearch()} directory={directory()} />
            </Show>
          </div>
        </AppPanel.Body>
      </AppPanel.Content>
    </AppPanel.Root>
  )
}
