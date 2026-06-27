import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { AppPanel } from "@/components/app-panel"
import type { MemoryStats } from "@ericsanchezok/synergy-sdk/client"
import { type View, formatBytes } from "./shared"
import { StatsView } from "./stats/stats-view"
import { StatsSection } from "@/components/stats/stats-section"
import { MemoryView } from "./memory-view"
import { ExperienceView } from "./experience-view"
import { SkillView } from "./skill-view"
import "./library-panel.css"

const viewLabel: Record<View, string> = {
  stats: "Health, collection, and learning signals",
  memory: "Browse, search, and manage knowledge",
  experience: "Browse, search, and manage behavioral records",
  skill: "Installed capabilities and imports",
}

function LibraryTabBar(props: {
  view: View
  memoryCount: number
  experienceCount: number
  onChange: (view: View) => void
}) {
  const items = (): Array<{ id: View; label: string; count?: number }> => [
    { id: "stats", label: "Overview" },
    { id: "memory", label: "Memories", count: props.memoryCount },
    { id: "experience", label: "Experiences", count: props.experienceCount },
    { id: "skill", label: "Skills" },
  ]

  return (
    <div class="library-tabbar" role="tablist" aria-label="Library views">
      <For each={items()}>
        {(item) => (
        <button
          type="button"
          role="tab"
          aria-selected={props.view === item.id}
          classList={{
            "library-tab": true,
            "is-active": props.view === item.id,
          }}
          onClick={() => props.onChange(item.id)}
        >
          <span>{item.label}</span>
          <Show when={(item.count ?? 0) > 0}>
            <span class="library-tab-count">{item.count}</span>
          </Show>
        </button>
        )}
      </For>
    </div>
  )
}

export function LibraryPanel() {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const params = useParams()
  const [view, setView] = createSignal<View>("stats")
  const [search, setSearch] = createSignal("")
  const [searchError, setSearchError] = createSignal(false)

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

  function refetchAll() {
    refetchStats()
    if (view() === "memory") refetchMemoryData()
    else if (view() === "experience") refetchExperienceData()
    else refetchSkillData()
  }

  let refetchMemoryData = () => {}
  let refetchExperienceData = () => {}
  let refetchSkillData = () => {}

  const showSearch = () => view() !== "stats"

  return (
    <AppPanel.Root class="library-workbench">
      <AppPanel.Content>
        <AppPanel.Header class="library-header">
          <AppPanel.HeaderRow>
            <AppPanel.Title>Library</AppPanel.Title>
            <AppPanel.Actions>
              <Show when={stats()}>
                <span class="library-storage-size tabular-nums">{formatBytes(stats()!.dbSizeBytes)}</span>
              </Show>
              <Show when={view() !== "stats"}>
                <button type="button" class="library-action-button" title="Refresh" onClick={refetchAll}>
                  <Icon name="refresh-ccw" size="small" />
                  <span>Refresh</span>
                </button>
              </Show>
            </AppPanel.Actions>
          </AppPanel.HeaderRow>
          <div class="library-header-controls">
            <LibraryTabBar
              view={view()}
              memoryCount={memoryCount()}
              experienceCount={experienceCount()}
              onChange={setView}
            />
            <Show when={showSearch()}>
              <div class="library-search-field">
                <Icon name="search" size="small" class="text-icon-weak shrink-0" />
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
                    <Icon name="x" size="small" />
                  </button>
                </Show>
              </div>
            </Show>
          </div>
          <div class="library-view-caption">{viewLabel[view()]}</div>
        </AppPanel.Header>
        <Show when={searchError()}>
          <div class="shrink-0 px-6 pb-1">
            <span class="text-11-regular text-text-diff-delete-base">
              Search unavailable — embedding API may not be configured
            </span>
          </div>
        </Show>
        <AppPanel.Body padding={false} class="library-body">
          <Show when={view() === "stats"}>
            <StatsView />
            <div class="library-section-block">
              <div class="library-section-heading">
                <span class="library-section-title">Workspace usage</span>
                <span class="library-section-subtitle">Activity analytics across all projects</span>
              </div>
              <StatsSection />
            </div>
          </Show>
          <Show when={view() === "memory"}>
            <MemoryView
              sdk={sdk}
              search={debouncedSearch()}
              isSearching={isSearching()}
              setSearchError={setSearchError}
              onRegisterRefetch={(fn) => (refetchMemoryData = fn)}
              refetchStats={refetchStats}
            />
          </Show>
          <Show when={view() === "experience"}>
            <ExperienceView
              sdk={sdk}
              search={debouncedSearch()}
              isSearching={isSearching()}
              setSearchError={setSearchError}
              onRegisterRefetch={(fn) => (refetchExperienceData = fn)}
              refetchStats={refetchStats}
              currentScopeID={currentScopeID()}
              currentSessionID={currentSessionID()}
            />
          </Show>
          <Show when={view() === "skill"}>
            <SkillView
              sdk={sdk}
              search={debouncedSearch()}
              directory={directory()}
              onRegisterRefetch={(fn) => (refetchSkillData = fn)}
            />
          </Show>
        </AppPanel.Body>
      </AppPanel.Content>
    </AppPanel.Root>
  )
}
