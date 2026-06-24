import { createResource, createSignal } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"

export type LibraryStatsSnapshot = {
  overview: {
    totalMemories: number
    totalExperiences: number
    evaluationRate: number
    experiencesEvaluated: number
    experiencesFailed: number
    experiencesPending: number
    scopeCount: number
    activeDays: number
  }
  memoryDistribution: {
    byCategory: Array<{ category: string; count: number }>
    byRecallMode: Array<{ recallMode: string; count: number }>
  }
  experienceRL: {
    rewardDimensions: Array<{
      dimension: string
      avg: number
      std: number
      distribution: Array<{ value: number; count: number }>
    }>
    qDistribution: {
      histogram: Array<{ bin: string; count: number }>
      trend: Array<{ period: string; medianQ: number; count: number }>
      avgCompositeQ: number
      medianCompositeQ: number
      stdCompositeQ: number
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

export const EMPTY_SNAPSHOT: LibraryStatsSnapshot = {
  overview: {
    totalMemories: 0,
    totalExperiences: 0,
    evaluationRate: 0,
    experiencesEvaluated: 0,
    experiencesFailed: 0,
    experiencesPending: 0,
    scopeCount: 0,
    activeDays: 0,
  },
  memoryDistribution: { byCategory: [], byRecallMode: [] },
  experienceRL: {
    rewardDimensions: [],
    qDistribution: { histogram: [], trend: [], avgCompositeQ: 0, medianCompositeQ: 0, stdCompositeQ: 0 },
    avgVisits: 0,
    medianVisits: 0,
    neverRetrieved: 0,
    frequentlyRetrieved: 0,
  },
  retrieval: { topExperiences: [], visitsDistribution: [] },
  scopes: { scopes: [] },
  timeSeries: { days: [], hourlyActivity: [] },
  computedAt: 0,
}

function isValidSnapshot(data: unknown): data is LibraryStatsSnapshot {
  return (
    typeof data === "object" &&
    data !== null &&
    "overview" in data &&
    "memoryDistribution" in data &&
    "experienceRL" in data &&
    "retrieval" in data
  )
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string") return error
  return "Unable to load library stats right now."
}

export function useLibraryStats() {
  const sdk = useGlobalSDK()
  const [error, setError] = createSignal<string | null>(null)

  const [data, { refetch }] = createResource(async (): Promise<LibraryStatsSnapshot | null> => {
    try {
      setError(null)
      const res = await sdk.client.library.stats({ recompute: "true" })
      const json = res.data
      if (!isValidSnapshot(json)) return null
      return json as LibraryStatsSnapshot
    } catch (err) {
      setError(getErrorMessage(err))
      return null
    }
  })

  const refresh = () => refetch()

  async function recompute() {
    try {
      setError(null)
      const res = await sdk.client.library.stats({ recompute: "true" })
      const json = res.data
      if (isValidSnapshot(json)) refresh()
      return (isValidSnapshot(json) ? json : null) as LibraryStatsSnapshot | null
    } catch (err) {
      setError(getErrorMessage(err))
      return null
    }
  }

  const loading = () => data.loading

  return { data, error, loading, refresh, recompute }
}
