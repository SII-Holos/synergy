import { createEffect, createMemo, createSignal, on, Show, Suspense, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLingui } from "@lingui/solid"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { AppPanel } from "@/components/app-panel"
import { WorkspaceMobileHeader } from "@/components/workspace/mobile-header"
import { useWorkspaceMobileHeaderClose } from "@/components/workspace/mobile-header-close"
import type { MemoryStats } from "@ericsanchezok/synergy-sdk/client"
import { type View, formatBytes } from "./shared"
import { StatsView, type LibraryStatsSyncHandle } from "./stats/stats-view"
import { StatsSection, type WorkspaceStatsSyncHandle } from "@/components/stats/stats-section"
import { MemoryView } from "./memory-view"
import { ExperienceView } from "./experience-view"
import { SkillView } from "./skill-view"
import { LibraryHome, type LibraryHomeSync } from "./home-view"
import "./library-panel.css"

export function LibraryPanel() {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const params = useParams()
  const onCloseWorkspace = useWorkspaceMobileHeaderClose()
  const { _ } = useLingui()
  const [view, setView] = createSignal<View>("home")
  const [statisticsView, setStatisticsView] = createSignal("knowledge")
  let searchInput: HTMLInputElement | undefined
  const [homeSync, setHomeSync] = createSignal<LibraryHomeSync>()
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

  onCleanup(() => clearTimeout(debounceTimer))
  createEffect(
    on(
      currentScopeID,
      () => {
        clearTimeout(debounceTimer)
        setSearch("")
        setDebouncedSearch("")
        setSearchError(false)
      },
      { defer: true },
    ),
  )

  const isSearching = () => !!debouncedSearch()

  const [stats, setStats] = createSignal<MemoryStats>()
  const statsController = new AbortController()
  onCleanup(() => statsController.abort())
  const refetchStats = async () => {
    const result = await sdk.client.library.stats(undefined, { signal: statsController.signal })
    if (!statsController.signal.aborted && result.data && "memory" in result.data) setStats(result.data)
  }
  void refetchStats().catch(() => undefined)

  const memoryCount = () => stats()?.memory.count ?? 0
  const experienceCount = () => stats()?.experience.count ?? 0

  const showSearch = () => view() !== "stats"
  const navItems = createMemo(() => [
    { id: "home", label: _({ id: "app.library.nav.home", message: "Overview" }) },
    {
      id: "memory",
      label:
        memoryCount() > 0
          ? _({
              id: "app.library.nav.memoriesCount",
              message: "Memories {count}",
              values: { count: "" + memoryCount() },
            })
          : _({ id: "app.library.nav.memories", message: "Memories" }),
    },
    {
      id: "experience",
      label:
        experienceCount() > 0
          ? _({
              id: "app.library.nav.experiencesCount",
              message: "Experiences {count}",
              values: { count: "" + experienceCount() },
            })
          : _({ id: "app.library.nav.experiences", message: "Experiences" }),
    },
    { id: "skill", label: _({ id: "app.library.nav.skills", message: "Skills" }) },
    { id: "stats", label: _({ id: "app.library.nav.stats", message: "Statistics" }) },
  ])
  const storageLabel = createMemo(() => {
    const snapshot = stats()
    return snapshot ? formatBytes(snapshot.dbSizeBytes) : undefined
  })
  const isSyncing = createMemo(() =>
    Boolean(
      view() === "home"
        ? homeSync()?.syncing()
        : statisticsView() === "usage"
          ? workspaceStatsSync()?.syncing()
          : libraryStatsSync()?.syncing(),
    ),
  )

  async function syncAll() {
    if (isSyncing()) return
    if (view() === "home") {
      await homeSync()?.sync()
      await refetchStats()
      return
    }
    const target = statisticsView() === "usage" ? workspaceStatsSync() : libraryStatsSync()
    await target?.sync()
    await refetchStats()
  }

  return (
    <AppPanel.Root class="library-workbench">
      <AppPanel.Content>
        <WorkspaceMobileHeader onClose={onCloseWorkspace} />
        <AppPanel.Header class="library-header">
          <div class="library-header-inner">
            <AppPanel.HeaderRow>
              <AppPanel.Title>{_({ id: "app.library.title", message: "Library" })}</AppPanel.Title>
              <Show when={view() === "home" || view() === "stats"}>
                <AppPanel.Actions>
                  <button
                    type="button"
                    class="library-primary-action disabled:cursor-default disabled:opacity-55"
                    disabled={isSyncing()}
                    onClick={() => void syncAll().catch(() => undefined)}
                  >
                    {isSyncing()
                      ? _({ id: "app.library.syncing", message: "Syncing..." })
                      : _({ id: "app.library.refresh", message: "Refresh" })}
                  </button>
                </AppPanel.Actions>
              </Show>
            </AppPanel.HeaderRow>
            <div class="library-header-controls" classList={{ "library-header-home": view() === "home" }}>
              <AppPanel.Tabs
                id="library"
                label={_({ id: "app.library.views", message: "Library views" })}
                items={navItems().map((item) => ({ id: item.id, label: item.label as string }))}
                active={view()}
                onChange={(id) => setView(id as View)}
              />
              <Show when={showSearch()}>
                <div class="library-search-field">
                  <Icon name={getSemanticIcon("action.search")} size="small" class="text-icon-weak-base shrink-0" />
                  <input
                    type="text"
                    ref={searchInput}
                    aria-label={_({ id: "app.library.search.label", message: "Search library" })}
                    placeholder={
                      view() === "home"
                        ? _({ id: "app.library.search.all", message: "Search memories, experiences and skills" })
                        : view() === "memory"
                          ? _({ id: "app.library.search.memories", message: "Search memories..." })
                          : view() === "experience"
                            ? _({ id: "app.library.search.experiences", message: "Search experiences..." })
                            : _({ id: "app.library.search.skills", message: "Search skills..." })
                    }
                    class="flex-1 bg-transparent app-panel-control text-text-base placeholder:text-text-weak outline-none"
                    value={search()}
                    onInput={(e) => onSearchInput(e.currentTarget.value)}
                  />
                  <Show when={search()}>
                    <button
                      type="button"
                      aria-label={_({ id: "app.library.clearSearch", message: "Clear search" })}
                      class="library-icon-button"
                      onClick={() => {
                        onSearchInput("")
                        searchInput?.focus()
                      }}
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
            <span class="app-panel-caption text-text-diff-delete-base">
              {_({
                id: "app.library.search.unavailable",
                message: "Search unavailable — embedding API may not be configured",
              })}
            </span>
          </div>
        </Show>
        <AppPanel.Body padding={false} class="library-body" tab={{ id: "library", value: view() }}>
          <Suspense>
            <div class="library-stage">
              <Show when={view() === "home"}>
                <LibraryHome
                  sdk={sdk}
                  search={debouncedSearch()}
                  scopeID={currentScopeID()}
                  scopeLabel={(id) => globalSync.data.scope.find((scope) => scope.id === id)?.name}
                  registerSync={setHomeSync}
                  onBrowse={(view, query) => {
                    setView(view)
                    onSearchInput(query ?? "")
                  }}
                />
              </Show>
              <Show when={view() === "stats"}>
                <AppPanel.Tabs
                  id="library-statistics"
                  label={_({ id: "app.library.stats.views", message: "Statistics views" })}
                  items={[
                    { id: "knowledge", label: _({ id: "app.library.stats.knowledge", message: "Knowledge" }) },
                    { id: "usage", label: _({ id: "app.library.stats.usage", message: "Usage" }) },
                  ]}
                  active={statisticsView()}
                  onChange={setStatisticsView}
                />
                <div
                  class="library-section-block"
                  hidden={statisticsView() !== "knowledge"}
                  role="tabpanel"
                  id="library-statistics-knowledge-panel"
                  aria-labelledby="library-statistics-knowledge"
                >
                  <Suspense>
                    <StatsView registerSync={setLibraryStatsSync} storageLabel={storageLabel()} />
                  </Suspense>
                </div>
                <div
                  class="library-section-block"
                  hidden={statisticsView() !== "usage"}
                  role="tabpanel"
                  id="library-statistics-usage-panel"
                  aria-labelledby="library-statistics-usage"
                >
                  <Suspense>
                    <StatsSection registerSync={setWorkspaceStatsSync} />
                  </Suspense>
                </div>
              </Show>
              <Show when={view() === "memory"}>
                <MemoryView
                  sdk={sdk}
                  scopeID={currentScopeID()}
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
                  scopeLabel={(id) => globalSync.data.scope.find((scope) => scope.id === id)?.name}
                />
              </Show>
              <Show when={view() === "skill"}>
                <SkillView sdk={sdk} search={debouncedSearch()} directory={directory()} scopeID={currentScopeID()} />
              </Show>
            </div>
          </Suspense>
        </AppPanel.Body>
      </AppPanel.Content>
    </AppPanel.Root>
  )
}
