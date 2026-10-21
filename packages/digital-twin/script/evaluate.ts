import path from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
import os from "node:os"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { z } from "zod"
import type { JSONSchema7 } from "ai"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { AgentCall } from "@ericsanchezok/synergy-harness/agent/call"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { RolloutEvents } from "@ericsanchezok/synergy-harness/session/rollout/events"
import { RolloutSchema } from "@ericsanchezok/synergy-harness/session/rollout/schema"
import { SecretMask } from "@ericsanchezok/synergy-harness/secrets/mask"
import { infer, type Recipe } from "../src/inference"
import { digitalTwin } from "../src/component"
import { registerAgents } from "./evaluator-worker"
import { loadHistory, historySourceHash, temporalEvidence, type ReplayCase } from "./history"
import { version } from "../package.json" with { type: "json" }

export function evaluationComponent(): RuntimeComponent {
  return {
    id: "digital-twin-evaluation",
    version,
    apiVersion: 1,
    requires: { "local-runtime": version },
    register: registerAgents,
    workers: { agent: new URL("./evaluator-worker.ts", import.meta.url) },
  }
}

const Label = z
  .object({
    predictable: z.boolean(),
    category: z.enum([
      "short-acceptance",
      "artifact-revision",
      "architectural-pushback",
      "changed-preference",
      "ambiguous-new-task",
      "other",
    ]),
    reason: z.string(),
  })
  .strict()
const Judgment = z
  .object({
    scores: z
      .array(
        z.object({
          label: z.enum(["A", "B", "C"]),
          content: z.number().int().min(1).max(5),
          voice: z.number().int().min(1).max(5),
          integrityFailures: z.array(z.string()),
          reason: z.string(),
        }),
      )
      .length(3),
    comparisons: z
      .array(
        z.object({
          a: z.enum(["A", "B", "C"]),
          b: z.enum(["A", "B", "C"]),
          winner: z.enum(["a", "b", "tie"]),
          reason: z.string(),
        }),
      )
      .length(3),
  })
  .strict()
const recipes: Recipe[] = ["context", "voice", "full"]
const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

async function writeCheckpoint(filename: string, text: string) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, text, { mode: 0o600 })
  await rename(temporary, filename)
}

const measurementScope = new AsyncLocalStorage<string>()

type CallIdentity = Pick<RolloutSchema.CallRecord, "owner" | "id">

async function measured<T>(agent: string, action: () => Promise<T>, onCall?: (call: CallIdentity) => Promise<void>) {
  const identity = crypto.randomUUID()
  const owners = new Set<string>()
  const calls = new Map<string, RolloutSchema.CallRecord>()
  const attempts = new Map<string, RolloutSchema.AttemptRecord>()
  let checkpoint = Promise.resolve()
  const dispose = Bus.subscribeGlobal(RolloutEvents.Updated, ({ properties }) => {
    if (properties.owner.kind !== "operation") return
    const record = properties.record
    if (record.kind === "call" && record.value.agent === agent && measurementScope.getStore() === identity)
      owners.add(properties.owner.operationID)
    if (!owners.has(properties.owner.operationID)) return
    if (record.kind === "call" && record.value.agent === agent) {
      if (!calls.has(record.value.id) && onCall) {
        const identity = { owner: record.value.owner, id: record.value.id }
        checkpoint = checkpoint.then(() => onCall(identity))
      }
      calls.set(record.value.id, record.value)
    }
    if (record.kind === "attempt") attempts.set(record.value.id, record.value)
  })
  const started = performance.now()
  let value: T | undefined
  let error: string | undefined
  try {
    value = await measurementScope.run(identity, action)
  } catch (cause) {
    error = cause instanceof Error ? `${cause.name}: ${cause.message}` : "Unknown failure"
  } finally {
    dispose()
    await checkpoint
  }
  return {
    value,
    error,
    receipt: {
      wallMs: performance.now() - started,
      calls: [...calls.values()].map((call) => ({
        owner: call.owner,
        id: call.id,
        model: call.model,
        usage: call.sdkUsage,
        request: call.request,
        response: call.response,
      })),
      attempts: [...attempts.values()]
        .filter((attempt) => calls.has(attempt.callID))
        .map((attempt) => ({ status: attempt.status, usage: attempt.usage ?? null, timing: attempt.timing ?? null })),
    },
  }
}
type Receipt = Awaited<ReturnType<typeof measured>>["receipt"]
type Prediction = {
  recipe: Recipe
  state: "pending" | "complete" | "failed"
  candidate: string | null
  abstention?: string | null
  error?: string
  elapsedMs?: number
  selectedEvidence?: ReturnType<typeof temporalEvidence>["evidence"]
  receipt?: Receipt
  calls?: CallIdentity[]
}
type Result = {
  fingerprint: string
  item: ReplayCase
  availableEvidence: number
  predictions: Prediction[]
  labels: Record<string, Recipe>
  eligibility?: z.infer<typeof Label>
  labelState?: "pending" | "complete"
  labelError?: string
  labelReceipt?: Receipt
  labelCalls?: CallIdentity[]
  judgment?: z.infer<typeof Judgment>
  judgeState?: "pending" | "complete"
  judgeError?: string
  judgeReceipt?: Receipt
  judgeCalls?: CallIdentity[]
  complete?: boolean
}

async function assess<T extends z.ZodType>(
  model: Provider.Model,
  schema: T,
  name: string,
  payload: object,
  onCall: (call: CallIdentity) => Promise<void>,
) {
  const measurement = await measured(
    "digital-twin-evaluator",
    async () =>
      AgentCall.text({
        agent: "digital-twin-evaluator",
        ownership: "operation",
        small: false,
        model,
        timeoutMs: 180_000,
        retries: 2,
        maxOutputTokens: Math.min(model.limit.output, 16_384),
        maxOutputChars: 65_536,
        messages: [{ role: "user", content: await SecretMask.apply(JSON.stringify({ ...payload, outputTool: name })) }],
        outputTool: {
          name,
          force: false,
          description: "Return the requested independent assessment through this schema.",
          schema: z.toJSONSchema(schema, { target: "draft-7" }) as JSONSchema7,
        },
      }),
    onCall,
  )
  try {
    if (!measurement.value) throw new Error(measurement.error)
    const calls = measurement.value.toolCalls?.filter((call) => call.name === name)
    if (calls?.length !== 1) throw new Error("Evaluator returned no unique assessment")
    return { value: schema.parse(calls[0]!.input) as z.infer<T>, receipt: measurement.receipt }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid assessment", receipt: measurement.receipt }
  }
}

// Provenance: https://doi.org/10.1080/01621459.1963.10500830 (Hoeffding, 1963).
// Local adaptation: widen the family bootstrap with a bounded weighted-family interval to avoid tiny-sample certainty.
export function pairedInterval(values: Array<{ family: string; win: number }>) {
  const families = [...new Set(values.map((value) => value.family))]
  if (families.length < 2) return [0, 1]
  let seed = 2311
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const samples: number[] = []
  const clusters = families.map((family) => values.filter((value) => value.family === family))
  for (let i = 0; i < 2000; i++) {
    const sample = families.flatMap(() => clusters[Math.floor(random() * clusters.length)]!)
    samples.push(sample.reduce((sum, value) => sum + value.win, 0) / sample.length)
  }
  samples.sort((a, b) => a - b)
  const mean = values.reduce((sum, value) => sum + value.win, 0) / values.length
  const squaredWeights = clusters.reduce((sum, cluster) => sum + (cluster.length / values.length) ** 2, 0)
  const radius = Math.sqrt((Math.log(40) * squaredWeights) / 2)
  return [Math.max(0, Math.min(samples[49]!, mean - radius)), Math.min(1, Math.max(samples[1949]!, mean + radius))]
}

export function summarize(results: Result[], expectedCases: number) {
  let predictable = 0,
    covered = 0,
    emitted = 0,
    passing = 0,
    wins = 0,
    losses = 0,
    ties = 0
  const paired: Array<{ family: string; win: number }> = []
  const categories: Record<string, { cases: number; predictable: number; covered: number }> = {}
  for (const result of results) {
    const full = result.predictions.find((prediction) => prediction.recipe === "full")
    const category = result.eligibility?.category ?? "unlabeled"
    const counts = (categories[category] ??= { cases: 0, predictable: 0, covered: 0 })
    counts.cases++
    if (full?.candidate) emitted++
    if (result.eligibility?.predictable) {
      predictable++
      counts.predictable++
      if (full?.candidate) {
        covered++
        counts.covered++
      }
    }
    if (!result.judgment) continue
    const label = Object.keys(result.labels).find((label) => result.labels[label] === "full")!
    const score = result.judgment.scores.find((score) => score.label === label)!
    if (full?.candidate && score.content >= 4 && score.voice >= 4 && !score.integrityFailures.length) passing++
    const context = Object.keys(result.labels).find((label) => result.labels[label] === "context")!
    const comparison = result.judgment.comparisons.find(
      (pair) => [pair.a, pair.b].includes(label as "A") && [pair.a, pair.b].includes(context as "A"),
    )!
    const win =
      comparison.winner === "tie" ? 0.5 : (comparison.winner === "a" ? comparison.a : comparison.b) === label ? 1 : 0
    if (win === 1) wins++
    else if (win === 0) losses++
    else ties++
    paired.push({ family: result.item.family, win })
  }
  const latency = Object.fromEntries(
    recipes.map((recipe) => {
      const values = results
        .flatMap((result) =>
          result.predictions
            .filter((prediction) => prediction.recipe === recipe && prediction.receipt)
            .map((prediction) => prediction.receipt!.wallMs),
        )
        .sort((a, b) => a - b)
      return [
        recipe,
        {
          count: values.length,
          medianMs: values[Math.floor(values.length / 2)] ?? null,
          p95Ms: values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? null,
        },
      ]
    }),
  )
  const interval = pairedInterval(paired)
  const coverage = predictable ? covered / predictable : null
  const quality = emitted ? passing / emitted : null
  const winRate = paired.length ? wins / paired.length : null
  const errors = results.filter(
    (result) =>
      result.labelError ||
      result.judgeError ||
      result.predictions.some((prediction) => prediction.state !== "complete"),
  ).length
  const finished = results.length === expectedCases && results.every((result) => result.complete)
  return {
    latency,
    categories,
    cases: results.length,
    expectedCases,
    finished,
    labeled: results.filter((result) => result.eligibility).length,
    judged: paired.length,
    errors,
    predictable,
    covered,
    emitted,
    passing,
    wins,
    losses,
    ties,
    families: new Set(paired.map((pair) => pair.family)).size,
    coverage,
    quality,
    winRate,
    paired95: interval,
    qualityResolved:
      results.length > 0 &&
      finished &&
      !errors &&
      paired.length === results.length &&
      (coverage ?? 0) >= 0.8 &&
      (quality ?? 0) >= 0.8 &&
      (winRate ?? 0) >= 0.65 &&
      interval[0]! > 0.5,
  }
}

function report(results: Result[], summary: ReturnType<typeof summarize>, metadata: object) {
  const lines = [
    "# Private Digital Twin temporal evaluation",
    "",
    "This report contains private conversation evidence. Do not publish or commit it.",
    "",
    "## Measurement",
    "",
    "```json",
    JSON.stringify({ ...metadata, summary }, null, 2),
    "```",
    "",
    "Quality is " +
      (summary.qualityResolved
        ? "supported by the measured gates; author confirmation remains separate."
        : "unresolved: one or more quality or evidence gates failed."),
    "",
    "Current context comes from immutable model requests and terminal responses. The terminal reply must match its unchanged appearance in the next immutable request; unverifiable display transformations are excluded. Fork/child Sessions and copied runs/calls are excluded. No later examples or future-derived sketches are used. Predictability/category are frozen before candidate generation. Provider failures are distinct from abstentions and prevent acceptance. The paired interval resamples whole Session families and is widened by a weighted bounded-variable Hoeffding interval so a tiny all-win sample cannot imply certainty. Latencies and actual token/cache/first-token receipts are retained per call; missing fields mean unknown.",
    "",
    "## All cases (chronological)",
    "",
  ]
  for (const result of results) {
    lines.push(
      `### ${result.item.id}`,
      "",
      `Cutoff: ${new Date(result.item.cutoff).toISOString()}; available authentic earlier inputs: ${result.availableEvidence}.`,
      "",
      "Actual next user message:",
      "",
      "```text",
      result.item.reference,
      "```",
      "",
      "Completed assistant reply:",
      "",
      "```text",
      result.item.reply,
      "```",
    )
    for (const prediction of result.predictions)
      lines.push(
        "",
        `**${prediction.recipe}** (${prediction.receipt ? `${Math.round(prediction.receipt.wallMs)} ms` : "unknown latency"})`,
        "",
        "```text",
        prediction.candidate ?? prediction.error ?? `Abstained: ${prediction.abstention}`,
        "```",
        "",
        prediction.selectedEvidence
          ? "Evidence actually supplied:"
          : "Selected evidence unavailable; inspect the immutable request in the call receipt.",
        "",
        "```json",
        JSON.stringify(
          prediction.selectedEvidence?.map(({ id, kind, text, previous }) => ({ id, kind, text, previous })) ?? null,
          null,
          2,
        ),
        "```",
      )
    lines.push(
      "",
      "Independent label and blinded assessment:",
      "",
      "```json",
      JSON.stringify(
        {
          eligibility: result.eligibility,
          judgment: result.judgment,
          labelError: result.labelError,
          judgeError: result.judgeError,
        },
        null,
        2,
      ),
      "```",
      "",
    )
  }
  return lines.join("\n")
}

export async function evaluate(input: {
  output: string
  model?: string
  judge?: string
  dataset?: Awaited<ReturnType<typeof loadHistory>>
  progress?: (value: object) => void
}) {
  const progress = input.progress ?? ((value) => console.log(JSON.stringify(value)))
  const config = await Config.current()
  const modelID = input.model ?? config.model
  const judgeID = input.judge ?? config.thinking_model ?? modelID
  if (!modelID || !judgeID) throw new Error("Explicit configured generation and evaluation models are required")
  const resolve = (id: string) => {
    const slash = id.indexOf("/")
    return Provider.getModel(id.slice(0, slash), id.slice(slash + 1))
  }
  const [model, judge] = await Promise.all([resolve(modelID), resolve(judgeID)])
  const started = performance.now()
  const dataset = input.dataset ?? (await loadHistory(progress))
  if (dataset.version !== 2 || dataset.sourceHash !== (await historySourceHash()))
    throw new Error("Historical evidence must be rebuilt with the current immutable extraction contract")
  const preparationMs = performance.now() - started
  const sources = await Promise.all(
    [
      "../src/prompts/predict.txt",
      "../src/inference.ts",
      "../src/evidence.ts",
      "../../harness/src/session/search-index.ts",
      "../../harness/src/agent/call.ts",
      "../../harness/src/session/llm.ts",
      "../../harness/src/provider/transform.ts",
      "../../harness/src/provider/thinking.ts",
      "./evaluator-worker.ts",
      "./history.ts",
      "./evaluate.ts",
    ].map((file) => Bun.file(new URL(file, import.meta.url)).text()),
  )
  const corpusHash = digest(JSON.stringify(dataset))
  const sourceHash = digest(sources.join("\n"))
  const experiment = digest(JSON.stringify({ corpusHash, sourceHash, model, judge, providerOptions: config.provider }))
  const directory = path.join(input.output, experiment)
  await mkdir(path.join(directory, "cases"), { recursive: true, mode: 0o700 })
  const manifest = {
    version: 1,
    experiment,
    concurrentCases: 4,
    generationModel: modelID,
    judgeModel: judgeID,
    corpusHash,
    sourceHash,
    sessions: dataset.sessions,
    authenticInputs: dataset.history.length,
    eligibleCases: dataset.cases.length,
    exclusions: dataset.exclusions,
    preparationMs: input.dataset ? null : preparationMs,
    targets: { predictableCoverage: 0.8, emittedContentAndVoice4: 0.8, fullWins: 0.65, paired95AboveChance: true },
  }
  await writeCheckpoint(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2))
  await writeCheckpoint(path.join(input.output, "latest.json"), JSON.stringify({ experiment, directory }))
  progress({ stage: "prepared", ...manifest })
  const results: Result[] = []
  async function evaluateCase(item: ReplayCase) {
    const fingerprint = digest(JSON.stringify({ experiment, item }))
    const filename = path.join(directory, "cases", digest(item.id) + ".json")
    const retrieval = performance.now()
    const evidence = temporalEvidence(item, dataset.history)
    const retrievalMs = performance.now() - retrieval
    const shuffled = recipes.toSorted((a, b) => digest(item.id + a).localeCompare(digest(item.id + b)))
    const labels = Object.fromEntries(shuffled.map((recipe, index) => [["A", "B", "C"][index]!, recipe]))
    const result: Result = (await Bun.file(filename).exists())
      ? await Bun.file(filename).json()
      : { fingerprint, item, availableEvidence: evidence.available, predictions: [], labels }
    if (result.fingerprint !== fingerprint) throw new Error("Experiment identity mismatch")
    const persist = async () => {
      await writeCheckpoint(filename, await SecretMask.apply(JSON.stringify({ ...result, retrievalMs }, null, 2)))
    }
    if (!result.complete) {
      if (result.labelState === "pending")
        result.labelError = "Interrupted labeling call; no replacement sample was drawn"
      if (!result.eligibility && !result.labelError) {
        result.labelState = "pending"
        await persist()
        const label = await assess(
          judge,
          Label,
          "label_continuation",
          {
            task: "Label whether the actual continuation was predictable from the completed situation, without seeing any proposed candidates. Freeze this label.",
            completedContext: item.current,
            authenticNextMessage: item.reference,
          },
          async (call) => {
            ;(result.labelCalls ??= []).push(call)
            await persist()
          },
        )
        result.eligibility = label.value
        result.labelError = label.error
        result.labelReceipt = label.receipt
        result.labelState = "complete"
        await persist()
      }
      for (const recipe of recipes) {
        const previous = result.predictions.find((prediction) => prediction.recipe === recipe)
        if (previous) {
          if (previous.state === "pending") {
            previous.state = "failed"
            previous.error = "Interrupted call: consult recorded operation receipts; no replacement sample was drawn"
            await persist()
          }
          continue
        }
        const prediction: Prediction = { recipe, state: "pending", candidate: null }
        result.predictions.push(prediction)
        await persist()
        progress({ stage: "predict", done: results.length, total: dataset.cases.length, recipe })
        const measurement = await measured(
          "digital-twin",
          () =>
            infer({
              current: item.current,
              evidence: evidence.evidence,
              statistics: evidence.statistics,
              model,
              recipe,
              onPrepared: async (selected) => {
                prediction.selectedEvidence = selected
                await persist()
              },
              metadata: { source: "digital-twin-evaluation", case: item.id, recipe, experiment },
            }),
          async (call) => {
            ;(prediction.calls ??= []).push(call)
            await persist()
          },
        )
        prediction.receipt = measurement.receipt
        if (measurement.value)
          Object.assign(prediction, {
            state: "complete",
            candidate: measurement.value.prediction.candidate,
            abstention: measurement.value.prediction.abstention,
            elapsedMs: measurement.value.elapsedMs,
            selectedEvidence: measurement.value.selected,
          })
        else {
          prediction.state = "failed"
          prediction.error = measurement.error
        }
        await persist()
      }
      if (result.judgeState === "pending")
        result.judgeError = "Interrupted judgment call; no replacement sample was drawn"
      if (!result.judgment && !result.judgeError) {
        result.judgeState = "pending"
        await persist()
        const judgment = await assess(
          judge,
          Judgment,
          "assess_predictions",
          {
            task: "Score all blinded candidates independently, preserving the frozen eligibility label. A failed call is not abstention; score it 1 and never count it as a correct abstention.",
            eligibility: result.eligibility,
            completedContext: item.current,
            authenticNextMessage: item.reference,
            authenticEarlierWriting: evidence.evidence
              .filter((entry) => entry.kind === "voice")
              .map((entry) => entry.text),
            candidates: Object.entries(labels).map(([label, recipe]) => {
              const prediction = result.predictions.find((prediction) => prediction.recipe === recipe)!
              return {
                label,
                state: prediction.state,
                text: prediction.candidate,
                abstention: prediction.abstention,
                error: prediction.error,
              }
            }),
            comparisonPairs: [
              ["A", "B"],
              ["A", "C"],
              ["B", "C"],
            ],
          },
          async (call) => {
            ;(result.judgeCalls ??= []).push(call)
            await persist()
          },
        )
        result.judgment = judgment.value
        result.judgeError = judgment.error
        result.judgeReceipt = judgment.receipt
        result.judgeState = "complete"
        if (
          result.judgment &&
          (new Set(result.judgment.scores.map((score) => score.label)).size !== 3 ||
            new Set(result.judgment.comparisons.map((pair) => [pair.a, pair.b].sort().join(""))).size !== 3 ||
            result.judgment.comparisons.some((pair) => pair.a === pair.b))
        ) {
          result.judgment = undefined
          result.judgeError = "Evaluator omitted a candidate or pair"
        }
      }
      result.complete = true
      await persist()
    }
    return result
  }
  const ordered = dataset.cases.toSorted((a, b) => a.cutoff - b.cutoff)
  for (let offset = 0; offset < ordered.length;) {
    const count = offset === 0 ? 1 : 4
    results.push(...(await Promise.all(ordered.slice(offset, offset + count).map(evaluateCase))))
    offset += count
    const summary = summarize(results, dataset.cases.length)
    await writeCheckpoint(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2))
    await writeCheckpoint(path.join(directory, "report.md"), await SecretMask.apply(report(results, summary, manifest)))
    progress({ stage: "evaluation", done: results.length, total: dataset.cases.length, summary })
  }
  const summary = summarize(results, dataset.cases.length)
  await writeCheckpoint(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2))
  await writeCheckpoint(path.join(directory, "report.md"), await SecretMask.apply(report(results, summary, manifest)))
  return { ...summary, directory }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      home: { type: "string" },
      output: { type: "string" },
      model: { type: "string" },
      judge: { type: "string" },
    },
    strict: true,
  })
  if (!values.home || !values.output || path.resolve(values.home) === os.homedir())
    throw new Error(
      "Provide --home <isolated-parent> --output <private-report-directory> [--model provider/model] [--judge provider/model]",
    )
  const { openAgentRuntime } = await import("@ericsanchezok/synergy-agent-runtime")
  const { createLocalHost } = await import("@ericsanchezok/synergy-local-runtime")
  const { localRuntime } = await import("@ericsanchezok/synergy-local-runtime/component")
  const host = createLocalHost({ home: values.home })
  const runtime = await openAgentRuntime({
    host,
    home: host.root,
    mode: "oneshot",
    listen: false,
    components: [localRuntime({ workers: false }), digitalTwin(), evaluationComponent()],
  })
  try {
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: () => evaluate({ output: values.output!, model: values.model, judge: values.judge }),
      }),
    )
  } finally {
    await runtime.close()
  }
}
