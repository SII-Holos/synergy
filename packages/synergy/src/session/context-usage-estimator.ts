import { Worker } from "node:worker_threads"

export namespace ContextUsageEstimator {
  const CATEGORY_KEYS = ["conversation", "toolActivity", "filesReferences", "instructions"] as const
  export const LIMITS = {
    activeWorkers: 2,
    workerTimeoutMs: 1_000,
    contributionsPerCategory: 64,
    sampleCharactersPerCategory: 2_048,
    sampleCharactersPerContribution: 256,
    sourceCharactersPerContribution: 64 * 1024 * 1024,
  } as const
  export type CategoryKey = (typeof CATEGORY_KEYS)[number]

  export interface Contribution {
    sample: string
    sourceCharacters: number
  }

  export interface Request {
    categories: Record<CategoryKey, Contribution[]>
    sampledCharacters: number
    truncated: boolean
  }

  export interface Result {
    categories: Record<CategoryKey, number>
    sampledCharacters: number
    truncated: boolean
  }

  let activeWorkers = 0

  export function estimate(request: Request): Promise<Result | undefined> {
    const bounded = parseRequest(request)
    if (!bounded || activeWorkers >= LIMITS.activeWorkers) return Promise.resolve(undefined)
    activeWorkers++

    return new Promise((resolve) => {
      let worker: Worker | undefined
      let settled = false
      const timer = setTimeout(() => settle(undefined), LIMITS.workerTimeoutMs)

      function settle(result: Result | undefined) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        activeWorkers--
        const current = worker
        worker = undefined
        if (current) void current.terminate().catch(() => {})
        resolve(result)
      }

      try {
        worker = new Worker(WORKER_SOURCE, { eval: true })
        worker.once("message", (value) => settle(parseResult(value)))
        worker.once("error", () => settle(undefined))
        worker.once("exit", () => settle(undefined))
        worker.postMessage(bounded)
      } catch {
        settle(undefined)
      }
    })
  }

  function parseRequest(value: Request): Request | undefined {
    if (!value || typeof value !== "object" || !value.categories || typeof value.categories !== "object") {
      return undefined
    }
    if (typeof value.truncated !== "boolean") return undefined

    let sampledCharacters = 0
    const categories = {} as Record<CategoryKey, Contribution[]>
    for (const key of CATEGORY_KEYS) {
      const source = value.categories[key]
      if (!Array.isArray(source) || source.length > LIMITS.contributionsPerCategory) return undefined

      let categoryCharacters = 0
      const contributions: Contribution[] = []
      for (const contribution of source) {
        if (!contribution || typeof contribution !== "object") return undefined
        if (
          typeof contribution.sample !== "string" ||
          contribution.sample.length > LIMITS.sampleCharactersPerContribution
        ) {
          return undefined
        }
        if (
          !Number.isSafeInteger(contribution.sourceCharacters) ||
          contribution.sourceCharacters < contribution.sample.length ||
          contribution.sourceCharacters > LIMITS.sourceCharactersPerContribution
        ) {
          return undefined
        }
        categoryCharacters += contribution.sample.length
        if (categoryCharacters > LIMITS.sampleCharactersPerCategory) return undefined
        contributions.push({
          sample: contribution.sample,
          sourceCharacters: contribution.sourceCharacters,
        })
      }
      sampledCharacters += categoryCharacters
      categories[key] = contributions
    }
    if (value.sampledCharacters !== sampledCharacters) return undefined
    return { categories, sampledCharacters, truncated: value.truncated }
  }

  function parseResult(value: unknown): Result | undefined {
    if (!value || typeof value !== "object") return undefined
    const result = value as Partial<Result>
    if (!result.categories || typeof result.categories !== "object") return undefined
    if (
      !Number.isSafeInteger(result.sampledCharacters) ||
      (result.sampledCharacters ?? -1) < 0 ||
      (result.sampledCharacters ?? 0) > CATEGORY_KEYS.length * LIMITS.sampleCharactersPerCategory
    ) {
      return undefined
    }
    if (typeof result.truncated !== "boolean") return undefined
    for (const key of CATEGORY_KEYS) {
      const estimate = (result.categories as Partial<Result["categories"]>)[key]
      if (typeof estimate !== "number" || !Number.isSafeInteger(estimate) || estimate < 0) return undefined
    }
    return result as Result
  }

  const WORKER_SOURCE = `
    const { parentPort } = require("node:worker_threads")

    parentPort.once("message", (request) => {
      const categories = {}
      for (const [key, contributions] of Object.entries(request.categories)) {
        let tokens = 0
        for (const contribution of contributions) {
          const sampleCharacters = contribution.sample.length
          if (sampleCharacters === 0 || contribution.sourceCharacters === 0) continue
          const sampleBytes = Buffer.byteLength(contribution.sample, "utf8")
          const estimatedBytes = (sampleBytes / sampleCharacters) * contribution.sourceCharacters
          tokens += Math.ceil(estimatedBytes / 4)
        }
        categories[key] = tokens
      }
      parentPort.postMessage({
        categories,
        sampledCharacters: request.sampledCharacters,
        truncated: request.truncated,
      })
    })
  `
}
