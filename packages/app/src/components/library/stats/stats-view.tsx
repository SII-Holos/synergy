import { createSignal, Show } from "solid-js"
import { useLibraryStats, type LibraryStatsSnapshot, EMPTY_SNAPSHOT } from "./use-library-stats"
import { LibraryOverviewCards } from "./overview-cards"
import { MemoryDistribution } from "./memory-distribution"
import { QValueChart } from "./q-value-chart"
import { RewardRadar } from "./reward-radar"

function SyncBar(props: { syncing: boolean; syncError: string | null; onSync: () => void }) {
  return (
    <div class="library-sync-row library-sync-row-compact">
      <Show when={props.syncing || props.syncError}>
        <span class="library-toolbar-summary">{props.syncing ? "Computing stats…" : (props.syncError ?? "")}</span>
      </Show>
      <button
        type="button"
        class="library-action-button shrink-0 disabled:cursor-default disabled:opacity-60"
        disabled={props.syncing}
        onClick={() => void props.onSync()}
      >
        {props.syncing ? "Computing…" : "Recompute"}
      </button>
    </div>
  )
}

function SectionHeader(props: { label: string; meta?: string }) {
  return (
    <div class="library-section-heading mt-5 mb-2 first:mt-4">
      <span class="library-section-title">{props.label}</span>
      <Show when={props.meta}>
        <span class="library-section-subtitle">{props.meta}</span>
      </Show>
    </div>
  )
}

export function StatsView() {
  const { data, error, loading, recompute } = useLibraryStats()
  const [syncing, setSyncing] = createSignal(false)
  const [syncError, setSyncError] = createSignal<string | null>(null)

  async function handleSync() {
    if (syncing()) return
    setSyncing(true)
    setSyncError(null)
    try {
      await recompute()
    } catch (err: any) {
      setSyncError(err?.message ?? "Sync failed")
    } finally {
      setSyncing(false)
    }
  }

  return (
    <>
      <SyncBar syncing={syncing()} syncError={syncError()} onSync={handleSync} />
      <Show
        when={data()}
        fallback={
          <div class="flex items-center justify-center py-12">
            <div class="flex max-w-sm flex-col items-center gap-2 text-center">
              <div class="text-12-medium text-text-base">
                {loading() ? "Loading library stats…" : "Library stats are unavailable right now"}
              </div>
              <Show when={error() && !loading()}>
                <div class="text-11-regular text-text-weak">{error()}</div>
              </Show>
            </div>
          </div>
        }
      >
        {(snapshot) => <LibraryStatsContent snapshot={snapshot() ?? EMPTY_SNAPSHOT} />}
      </Show>
    </>
  )
}

function LibraryStatsContent(props: { snapshot: LibraryStatsSnapshot }) {
  const s = () => props.snapshot
  const ov = () => s().overview

  return (
    <div class="flex flex-col gap-0 pb-5">
      <SectionHeader label="Collection" meta={`${ov().totalMemories + ov().totalExperiences} items`} />
      <LibraryOverviewCards overview={ov()} />

      <SectionHeader label="Signals" />
      <MemoryDistribution distribution={s().memoryDistribution} totalMemories={ov().totalMemories} />

      <SectionHeader label="Learning" />
      <RewardRadar dimensions={s().experienceRL.rewardDimensions} />
      <QValueChart distribution={s().experienceRL.qDistribution} rl={s().experienceRL} />
    </div>
  )
}
