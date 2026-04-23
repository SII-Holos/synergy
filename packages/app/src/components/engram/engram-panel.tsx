import { createMemo, createResource, createSignal, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { Panel } from "@/components/panel"
import type { MemoryStats } from "@ericsanchezok/synergy-sdk/client"
import { type View, ViewTab, formatBytes } from "./shared"
import { StatsView } from "./stats/stats-view"
import { MemoryView } from "./memory-view"
import { ExperienceView } from "./experience-view"
import { SkillView } from "./skill-view"

export function EngramPanel() {
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
    const [store] = globalSync.child(dir)
    return store.session.find((session) => session.id === sessionID)
  })
  const currentSessionID = createMemo(() => currentSession()?.id)
  const currentScopeID = createMemo(() => {
    const dir = directory()
    if (!dir) return undefined
    const [store] = globalSync.child(dir)
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
    const result = await sdk.client.engram.stats()
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
    <Panel.Root>
      <Panel.Header>
        <Panel.HeaderRow>
          <div class="flex items-center flex-1 min-w-0 gap-0.5 rounded-lg bg-surface-inset-base/50 p-0.5">
            <ViewTab active={view() === "stats"} onClick={() => setView("stats")}>
              Stats
            </ViewTab>
            <ViewTab active={view() === "memory"} onClick={() => setView("memory")}>
              Memory
              <Show when={memoryCount() > 0}>
                <span class="ml-1 text-text-weaker">{memoryCount()}</span>
              </Show>
            </ViewTab>
            <ViewTab active={view() === "experience"} onClick={() => setView("experience")}>
              Experience
              <Show when={experienceCount() > 0}>
                <span class="ml-1 text-text-weaker">{experienceCount()}</span>
              </Show>
            </ViewTab>
            <ViewTab active={view() === "skill"} onClick={() => setView("skill")}>
              Skill
            </ViewTab>
          </div>
          <Panel.Actions>
            <Show when={stats()}>
              <span class="text-11-regular text-text-weaker mr-0.5">{formatBytes(stats()!.dbSizeBytes)}</span>
            </Show>
            <Show when={view() !== "stats"}>
              <Panel.Action icon="refresh-ccw" title="Refresh" onClick={refetchAll} />
            </Show>
          </Panel.Actions>
        </Panel.HeaderRow>
        <Show when={showSearch()}>
          <Panel.Search
            value={search()}
            onInput={onSearchInput}
            placeholder={
              view() === "memory"
                ? "Search memories..."
                : view() === "experience"
                  ? "Search experiences..."
                  : "Search skills..."
            }
          />
        </Show>
        <Show when={searchError()}>
          <span class="text-11-regular text-text-diff-delete-base">
            Search unavailable — embedding API may not be configured
          </span>
        </Show>
      </Panel.Header>

      <Show when={view() === "stats"}>
        <StatsView />
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
    </Panel.Root>
  )
}
