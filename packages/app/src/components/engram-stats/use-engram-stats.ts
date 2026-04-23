import { createResource, createSignal } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"

export type EngramStatsSnapshot = {
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

export const EMPTY_SNAPSHOT: EngramStatsSnapshot = {
  overview: {
    totalMemories: 0,
    totalExperiences: 0,
    memoriesEdited: 0,
    experiencesEvaluated: 0,
    experiencesFailed: 0,
    experiencesPending: 0,
    scopeCount: 0,
    activeDays: 0,
  },
  memoryDistribution: { byCategory: [], byRecallMode: [], categoryRecallMatrix: {} },
  experienceRL: {
    rewardDimensions: [],
    qDistribution: { negative: 0, low: 0, neutral: 0, medium: 0, high: 0, avgCompositeQ: 0, medianCompositeQ: 0 },
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

function isValidSnapshot(data: unknown): data is EngramStatsSnapshot {
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
  return "Unable to load knowledge stats right now."
}

export function useEngramStats() {
  const sdk = useGlobalSDK()
  const [error, setError] = createSignal<string | null>(null)

  const [data, { refetch }] = createResource(async (): Promise<EngramStatsSnapshot | null> => {
    try {
      setError(null)
      const res = await fetch(`${sdk.url}/engram/stats`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (!isValidSnapshot(json)) return null
      return json
    } catch (err) {
      setError(getErrorMessage(err))
      return null
    }
  })

  const refresh = () => refetch()

  async function recompute() {
    try {
      setError(null)
      const res = await fetch(`${sdk.url}/engram/stats?recompute=true`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (isValidSnapshot(json)) refresh()
      return isValidSnapshot(json) ? json : null
    } catch (err) {
      setError(getErrorMessage(err))
      return null
    }
  }

  const loading = () => data.loading

  return { data, error, loading, refresh, recompute }
}
