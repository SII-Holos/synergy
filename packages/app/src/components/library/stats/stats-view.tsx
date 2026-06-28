import { createEffect, createSignal, Show } from "solid-js"
import { useLibraryStats, type LibraryStatsSnapshot, EMPTY_SNAPSHOT } from "./use-library-stats"
import { LibraryOverviewCards } from "./overview-cards"
import { MemoryDistribution } from "./memory-distribution"
import { QValueChart } from "./q-value-chart"
import { RewardRadar } from "./reward-radar"

export type LibraryStatsSyncHandle = {
  sync: () => Promise<void>
  syncing: () => boolean
  error: () => string | null
}

function SyncStatus(props: { syncing: boolean; syncError: string | null }) {
  return (
    <Show when={props.syncing || props.syncError}>
      <div class="library-sync-row library-sync-row-compact">
        <span class="library-toolbar-summary">{props.syncing ? "Computing stats…" : (props.syncError ?? "")}</span>
      </div>
    </Show>
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

export function StatsView(props: {
  registerSync?: (handle: LibraryStatsSyncHandle) => void
  storageLabel?: string
}) {
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

  createEffect(() => {
    props.registerSync?.({
      sync: handleSync,
      syncing,
      error: syncError,
    })
  })

  return (
    <>
      <SyncStatus syncing={syncing()} syncError={syncError()} />
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
        {(snapshot) => <LibraryStatsContent snapshot={snapshot() ?? EMPTY_SNAPSHOT} storageLabel={props.storageLabel} />}
      </Show>
    </>
  )
}

function LibraryStatsContent(props: { snapshot: LibraryStatsSnapshot; storageLabel?: string }) {
  const s = () => props.snapshot
  const ov = () => s().overview
  const collectionMeta = () => {
    const itemCount = `${ov().totalMemories + ov().totalExperiences} items`
    return props.storageLabel ? `${itemCount} · ${props.storageLabel} local store` : itemCount
  }

  return (
    <div class="flex flex-col gap-0 pb-5">
      <SectionHeader label="Collection" meta={collectionMeta()} />
      <LibraryOverviewCards overview={ov()} />

      <SectionHeader label="Signals" />
      <MemoryDistribution distribution={s().memoryDistribution} totalMemories={ov().totalMemories} />

      <SectionHeader label="Learning" />
      <RewardRadar dimensions={s().experienceRL.rewardDimensions} />
      <QValueChart distribution={s().experienceRL.qDistribution} rl={s().experienceRL} />
    </div>
  )
}
