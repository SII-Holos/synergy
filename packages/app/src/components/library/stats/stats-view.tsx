import { createSignal, Show } from "solid-js"
import { useLibraryStats, type LibraryStatsSnapshot, EMPTY_SNAPSHOT } from "./use-library-stats"
import { LibraryOverviewCards } from "./overview-cards"
import { MemoryDistribution } from "./memory-distribution"
import { QValueChart } from "./q-value-chart"
import { RewardRadar } from "./reward-radar"

function SyncBar(props: { syncing: boolean; syncError: string | null; onSync: () => void }) {
  return (
    <div class="mb-4 flex items-center justify-between gap-3 rounded-xl bg-surface-inset-base px-3.5 py-2.5 ring-1 ring-inset ring-border-base/45">
      <div class="min-w-0">
        <div class="text-11-regular text-text-weak">
          {props.syncing ? "Computing stats…" : (props.syncError ?? "Recompute for a fresh snapshot")}
        </div>
      </div>
      <button
        type="button"
        class="shrink-0 rounded-full bg-surface-raised-stronger-non-alpha px-3 py-1.5 text-11-medium text-text-interactive-base ring-1 ring-inset ring-border-base/50 transition hover:bg-surface-raised-base-hover hover:text-text-interactive-hover disabled:cursor-default disabled:opacity-60"
        disabled={props.syncing}
        onClick={() => void props.onSync()}
      >
        {props.syncing ? "Computing…" : "Recompute"}
      </button>
    </div>
  )
}

function SectionHeader(props: { label: string; subtitle: string }) {
  return (
    <div class="flex items-baseline gap-2 mt-5 mb-2 px-0.5">
      <span class="text-12-medium text-text-strong">{props.label}</span>
      <span class="text-11-regular text-text-weaker">{props.subtitle}</span>
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
      <SectionHeader
        label="Collection"
        subtitle={`${ov().totalMemories + ov().totalExperiences} items over ${ov().scopeCount} scopes`}
      />
      <LibraryOverviewCards overview={ov()} />

      <SectionHeader label="Signals" subtitle="Memory distribution and recall patterns" />
      <MemoryDistribution distribution={s().memoryDistribution} totalMemories={ov().totalMemories} />

      <SectionHeader label="Learning" subtitle="Reward dimensions and quality trends" />
      <RewardRadar dimensions={s().experienceRL.rewardDimensions} />
      <QValueChart distribution={s().experienceRL.qDistribution} rl={s().experienceRL} />
    </div>
  )
}
