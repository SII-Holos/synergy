import path from "path"
import { Log } from "../util/log"
import { Global } from "../global"
import { Embedding } from "./embedding"
import { EngramDB } from "./database"
import { Config } from "../config/config"

const log = Log.create({ service: "engram.experience-recall" })

export namespace ExperienceRecall {
  export interface Options {
    topK?: number
    epsilon?: number
    wSim?: number
    wQ?: number
    explorationConstant?: number
    simThreshold?: number
    vector?: number[]
  }

  export interface Result {
    id: string
    sessionID: string
    scopeID: string
    intent: string
    sourceProviderID: string | null
    sourceModelID: string | null
    reward: number | null
    similarity: number
    qValue: number
    qValues: Record<string, number>
    qVisits: number
    turnsRemaining: number | null
    score: number
    script: string | null
    raw: string | null
    rewards: EngramDB.Experience.Rewards
    createdAt: number
    updatedAt: number
  }

  const pendingRetrievals = new Map<string, string[]>()

  export function trackRetrieval(sessionID: string, experienceIDs: string[]) {
    pendingRetrievals.set(sessionID, experienceIDs)
  }

  export function consumeRetrieval(sessionID: string): string[] {
    const ids = pendingRetrievals.get(sessionID)
    pendingRetrievals.delete(sessionID)
    return ids ?? []
  }

  export async function retrieve(scopeID: string | undefined, query: string, options: Options = {}): Promise<Result[]> {
    const config = await Config.get()
    const evo = Config.resolveEvolution(config.identity?.evolution)
    const retrieval = evo.passiveRetrieval
    const rewardWeights = evo.learning.rewardWeights

    const topK = options.topK ?? retrieval.topK
    const epsilon = options.epsilon ?? retrieval.epsilon
    const wSim = options.wSim ?? retrieval.wSim
    const wQ = options.wQ ?? retrieval.wQ
    const explorationConstant = options.explorationConstant ?? retrieval.explorationConstant
    const simThreshold = options.simThreshold ?? retrieval.simThreshold

    using _ = log.time("retrieve", { scopeID })

    let queryEmbedding: number[]
    if (options.vector) {
      queryEmbedding = options.vector
    } else {
      try {
        const embeddingResult = await Embedding.generate({ id: "query", text: query })
        queryEmbedding = embeddingResult.vector
      } catch (err: any) {
        log.error("query embedding failed", { error: err?.message ?? String(err) })
        return []
      }
    }

    const knnResults = scopeID
      ? EngramDB.Experience.searchByIntent(scopeID, queryEmbedding, topK * 3)
      : EngramDB.Experience.searchByIntentAll(queryEmbedding, topK * 3)

    if (knnResults.length === 0) {
      log.info("no KNN results", { scopeID })
      return []
    }

    const candidates: Array<{ row: EngramDB.Experience.Row; similarity: number }> = []
    for (const knn of knnResults) {
      const row = EngramDB.Experience.get(knn.id)
      if (!row) continue
      const similarity = 1 - knn.distance
      if (similarity < simThreshold) continue
      candidates.push({ row, similarity })
    }

    log.info("phase A", { knnResults: knnResults.length, candidates: candidates.length, simThreshold })
    if (candidates.length === 0) return []

    const similarities = candidates.map((c) => c.similarity)
    const qScalars = candidates.map((c) => {
      const qv: Record<string, number> = JSON.parse(c.row.q_values)
      return (
        (qv.outcome ?? 0) * (rewardWeights.outcome ?? 0.35) +
        (qv.intent ?? 0) * (rewardWeights.intent ?? 0.25) +
        (qv.execution ?? 0) * (rewardWeights.execution ?? 0.2) +
        (qv.orchestration ?? 0) * (rewardWeights.orchestration ?? 0.1) +
        (qv.expression ?? 0) * (rewardWeights.expression ?? 0.1)
      )
    })

    const zSim = zScoreNormalize(similarities)
    const zQ = zScoreNormalize(qScalars)

    const totalVisits = candidates.reduce((sum, c) => sum + c.row.q_visits, 0)
    const lnN = totalVisits > 0 ? Math.log(totalVisits) : 1

    const scored = candidates.map((c, i) => {
      const base = zSim[i] * wSim + zQ[i] * wQ
      const n = Math.max(c.row.q_visits, 1)
      const ucbBonus = explorationConstant * Math.sqrt(lnN / n)
      return { ...c, score: base + ucbBonus, qScalar: qScalars[i] }
    })

    const selected = epsilonGreedy(scored, topK, epsilon)

    const results: Result[] = []
    for (const item of selected) {
      const contentRow = EngramDB.Experience.getContent(item.row.id)
      const qv: Record<string, number> = JSON.parse(item.row.q_values)
      results.push({
        id: item.row.id,
        sessionID: item.row.session_id,
        scopeID: item.row.scope_id,
        intent: item.row.intent,
        sourceProviderID: item.row.source_provider_id,
        sourceModelID: item.row.source_model_id,
        reward: item.row.reward,
        similarity: item.similarity,
        qValue: item.qScalar,
        qValues: qv,
        qVisits: item.row.q_visits,
        turnsRemaining: item.row.turns_remaining,
        score: item.score,
        script: contentRow?.script ?? null,
        raw: contentRow?.raw ?? null,
        rewards: parseRewards(item.row.rewards),
        createdAt: item.row.created_at,
        updatedAt: item.row.updated_at,
      })
    }

    log.info("phase B", { selected: results.length, topK, epsilon })
    return results
  }

  function zScoreNormalize(values: number[]): number[] {
    if (values.length === 0) return []
    if (values.length === 1) return [0]

    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
    const std = Math.sqrt(variance)

    if (std === 0) return values.map(() => 0)
    return values.map((v) => (v - mean) / std)
  }

  function epsilonGreedy<T extends { score: number }>(items: T[], k: number, epsilon: number): T[] {
    if (items.length <= k) return items

    const result: T[] = []
    const remaining = [...items]

    for (let i = 0; i < k && remaining.length > 0; i++) {
      if (Math.random() < epsilon) {
        const idx = Math.floor(Math.random() * remaining.length)
        result.push(remaining.splice(idx, 1)[0])
      } else {
        remaining.sort((a, b) => b.score - a.score)
        result.push(remaining.splice(0, 1)[0])
      }
    }

    return result
  }

  const DEBUG_LOG = path.join(Global.Path.engramDebug, "retrieval-debug.jsonl")

  export function writeDebugLog(
    sessionID: string,
    scopeID: string,
    query: string,
    results: Result[],
    injected?: string,
  ) {
    const entry = {
      time: new Date().toISOString(),
      sessionID,
      scopeID,
      query: query.length > 200 ? query.slice(0, 200) + "..." : query,
      results: results.map((r) => ({
        id: r.id,
        intent: r.intent,
        similarity: +r.similarity.toFixed(4),
        qValue: +r.qValue.toFixed(4),
        score: +r.score.toFixed(4),
      })),
      ...(injected ? { injected } : {}),
    }
    const line = JSON.stringify(entry) + "\n"
    ;(async () => {
      const prev = await Bun.file(DEBUG_LOG)
        .text()
        .catch(() => "")
      await Bun.write(DEBUG_LOG, prev + line)
    })().catch(() => {})
  }

  function parseRewards(raw: string): EngramDB.Experience.Rewards {
    try {
      return JSON.parse(raw) as EngramDB.Experience.Rewards
    } catch {
      return {}
    }
  }

  const EVALUATION_PHRASES: Record<string, { pos: string; zero: string; neg: string }> = {
    outcome: {
      pos: "the task was completed successfully",
      zero: "the task outcome was unclear",
      neg: "the task failed or produced incorrect results",
    },
    intent: {
      pos: "the user's intent was well understood",
      zero: "the request was straightforward",
      neg: "the user's intent was misunderstood",
    },
    execution: {
      pos: "the approach was efficient and effective",
      zero: "the approach was adequate",
      neg: "the approach was inefficient or got stuck",
    },
    orchestration: {
      pos: "tools and agents were well coordinated",
      zero: "no significant coordination was needed",
      neg: "tool or agent coordination was poor",
    },
    expression: {
      pos: "the response was clear and well-structured",
      zero: "the response was adequate",
      neg: "the response was unclear or verbose",
    },
  }

  export function buildEvaluation(rewards: EngramDB.Experience.Rewards, snapThreshold: number = 0.5): string {
    const positives: string[] = []
    const negatives: string[] = []

    for (const [dim, phrases] of Object.entries(EVALUATION_PHRASES)) {
      const score = rewards[dim as keyof EngramDB.Experience.Rewards]
      if (typeof score !== "number") continue
      if (score >= snapThreshold) positives.push(phrases.pos)
      else if (score <= -snapThreshold) negatives.push(phrases.neg)
    }

    if (positives.length === 0 && negatives.length === 0) return rewards.reason ?? ""

    let result = ""
    if (positives.length > 0) {
      result = capitalize(joinNatural(positives))
    }
    if (negatives.length > 0) {
      const negText = joinNatural(negatives)
      result = result ? `${result}, but ${negText}.` : `${capitalize(negText)}.`
    } else {
      result += "."
    }

    return result
  }

  function joinNatural(items: string[]): string {
    if (items.length === 0) return ""
    if (items.length === 1) return items[0]
    if (items.length === 2) return `${items[0]} and ${items[1]}`
    return items.slice(0, -1).join(", ") + ", and " + items.at(-1)
  }

  function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1)
  }
}
