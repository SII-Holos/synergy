import { createMemo, createResource, createSignal, Show } from "solid-js"
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

const viewLabel: Record<View, string> = {
  stats: "Health, collection, and learning signals",
  memory: "Browse, search, and manage knowledge",
  experience: "Browse, search, and manage behavioral records",
  skill: "Installed capabilities and imports",
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
    <AppPanel.Root>
      <AppPanel.Nav>
        <AppPanel.NavSection label="Library">
          <AppPanel.NavItem
            icon="activity"
            label="Overview"
            active={view() === "stats"}
            onClick={() => setView("stats")}
          />
          <AppPanel.NavItem
            icon="book-open"
            label="Memories"
            active={view() === "memory"}
            onClick={() => setView("memory")}
            badge={
              <Show when={memoryCount() > 0}>
                <span class="text-11-regular text-text-weaker">{memoryCount()}</span>
              </Show>
            }
          />
          <AppPanel.NavItem
            icon="zap"
            label="Experiences"
            active={view() === "experience"}
            onClick={() => setView("experience")}
            badge={
              <Show when={experienceCount() > 0}>
                <span class="text-11-regular text-text-weaker">{experienceCount()}</span>
              </Show>
            }
          />
          <AppPanel.NavItem
            icon="sparkles"
            label="Skills"
            active={view() === "skill"}
            onClick={() => setView("skill")}
          />
        </AppPanel.NavSection>
      </AppPanel.Nav>

      <AppPanel.Content>
        <AppPanel.Header class="pt-3 pb-2 gap-2">
          <AppPanel.HeaderRow>
            <AppPanel.Title>Library</AppPanel.Title>
            <AppPanel.Actions>
              <Show when={stats()}>
                <span class="text-11-regular text-text-weaker tabular-nums">{formatBytes(stats()!.dbSizeBytes)}</span>
              </Show>
              <Show when={view() !== "stats"}>
                <AppPanel.Action icon="refresh-ccw" title="Refresh" onClick={refetchAll} />
              </Show>
            </AppPanel.Actions>
          </AppPanel.HeaderRow>
          <AppPanel.Subtitle>{viewLabel[view()]}</AppPanel.Subtitle>
        </AppPanel.Header>
        <Show when={showSearch()}>
          <div class="shrink-0 px-6 pt-1 pb-2">
            <div class="flex items-center gap-2.5 rounded-xl bg-surface-inset-base/60 px-3.5 py-2">
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
                  class="flex items-center justify-center size-5 rounded-md text-icon-weak hover:text-icon-base transition-colors"
                  onClick={() => onSearchInput("")}
                >
                  <Icon name="x" size="small" />
                </button>
              </Show>
            </div>
          </div>
        </Show>
        <Show when={searchError()}>
          <div class="shrink-0 px-6 pb-1">
            <span class="text-11-regular text-text-diff-delete-base">
              Search unavailable — embedding API may not be configured
            </span>
          </div>
        </Show>
        <AppPanel.Body>
          <Show when={view() === "stats"}>
            <StatsView />
            <div class="mt-6 pt-5 border-t border-border-base/20">
              <div class="flex items-baseline gap-2 mb-3 px-0.5">
                <span class="text-12-medium text-text-strong">Workspace usage</span>
                <span class="text-11-regular text-text-weaker">Activity analytics across all projects</span>
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
