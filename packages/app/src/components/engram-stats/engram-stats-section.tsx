import { createSignal, Show } from "solid-js"
import { useEngramStats } from "./use-engram-stats"
import { EngramOverviewCards } from "./overview-cards"
import { MemoryDistribution } from "./memory-distribution"
import { QValueChart } from "./q-value-chart"
import { RewardRadar } from "./reward-radar"
import { RetrievalRanking } from "./retrieval-ranking"

type Snapshot = {
  overview: {
    totalMemories: number
    totalExperiences: number
    memoriesEdited: number
    experiencesEvaluated: number
    experiencesFailed: number
    experiencesPending: number
    scopeCount: number
    activeDays: number
  }
  memoryDistribution: {
    byCategory: Array<{ category: string; count: number }>
    byRecallMode: Array<{ recallMode: string; count: number }>
    categoryRecallMatrix: Record<string, number>
  }
  experienceRL: {
    rewardDimensions: Array<{ dimension: string; avg: number; median: number; p90: number }>
    qDistribution: {
      negative: number
      low: number
      neutral: number
      medium: number
      high: number
      avgCompositeQ: number
      medianCompositeQ: number
    }
    avgVisits: number
    medianVisits: number
    neverRetrieved: number
    frequentlyRetrieved: number
  }
  retrieval: {
    topExperiences: Array<{ id: string; intent: string; scopeID: string; visits: number; compositeQ: number }>
    visitsDistribution: Array<{ range: string; count: number }>
  }
  scopes: {
    scopes: Array<{ scopeID: string; memories: number; experiences: number; evaluated: number }>
  }
  timeSeries: {
    days: Array<{
      day: string
      memoriesCreated: number
      experiencesCreated: number
      experiencesEvaluated: number
      avgCompositeQ: number
    }>
    hourlyActivity: number[]
  }
  computedAt: number
}

function SyncBar(props: { syncing: boolean; syncError: string | null; onSync: () => void }) {
  return (
    <div class="mb-4 rounded-[1.15rem] bg-surface-inset-base/42 p-3 ring-1 ring-inset ring-border-base/45 shadow-[inset_0_1px_0_rgba(214,204,190,0.07)]">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="text-[10px] font-medium uppercase tracking-[0.16em] text-text-weaker">Knowledge Stats</div>
          <div class="mt-1 text-13-medium text-text-base">
            {props.syncing
              ? "Computing knowledge stats…"
              : (props.syncError ?? "Recompute knowledge stats when you want a fresh rollup.")}
          </div>
        </div>

        <button
          type="button"
          class="rounded-full bg-surface-raised-stronger-non-alpha px-3 py-1.5 text-12-medium text-text-interactive-base ring-1 ring-inset ring-border-base/50 transition hover:bg-surface-raised-base-hover hover:text-text-interactive-hover disabled:cursor-default disabled:opacity-60"
          disabled={props.syncing}
          onClick={() => void props.onSync()}
        >
          {props.syncing ? "Syncing…" : "Sync stats"}
        </button>
      </div>
    </div>
  )
}

export function EngramStatsSection() {
  const { data, error, loading, refresh, recompute } = useEngramStats()
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
    <div>
      <SyncBar syncing={syncing()} syncError={syncError()} onSync={handleSync} />
      <Show
        when={data()}
        fallback={
          <div class="flex items-center justify-center py-12">
            <div class="flex max-w-sm flex-col items-center gap-2 text-center">
              <div class="text-12-medium text-text-base">
                {loading() ? "Loading knowledge stats…" : "Knowledge stats are unavailable right now"}
              </div>
              <Show when={error() && !loading()}>
                <div class="text-11-regular text-text-weak">{error()}</div>
              </Show>
            </div>
          </div>
        }
      >
        {(snapshot) => <EngramStatsContent snapshot={snapshot() as Snapshot} />}
      </Show>
    </div>
  )
}

function EngramStatsContent(props: { snapshot: Snapshot }) {
  const s = () => props.snapshot

  return (
    <div class="flex flex-col gap-0 pb-5">
      <EngramOverviewCards overview={s().overview} />
      <MemoryDistribution distribution={s().memoryDistribution} totalMemories={s().overview.totalMemories} />
      <RewardRadar dimensions={s().experienceRL.rewardDimensions} />
      <QValueChart distribution={s().experienceRL.qDistribution} rl={s().experienceRL} />
      <RetrievalRanking retrieval={s().retrieval} />
    </div>
  )
}
