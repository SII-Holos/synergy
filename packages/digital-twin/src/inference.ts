import { z } from "zod"
import type { ModelMessage, JSONSchema7 } from "ai"
import { AgentCall } from "@ericsanchezok/synergy-harness/agent/call"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { Token } from "@ericsanchezok/synergy-harness/util/token"
import { SecretMask } from "@ericsanchezok/synergy-harness/secrets/mask"
import { DigitalTwinContract } from "./contract"
import { sketch, type Evidence, type Sketch } from "./evidence"
import prompt from "./prompts/predict.txt"

const Prediction = z
  .object({
    candidate: z.string().min(1).nullable(),
    abstention: z.enum(["insufficient-grounding", "no-clear-continuation"]).nullable(),
    grounding: z.array(z.string()).min(1).describe('Exact evidence IDs, always including "current". No explanations.'),
    targets: z
      .array(z.string())
      .describe("Concrete names or paths copied verbatim from the current conversation; otherwise an empty array."),
  })
  .strict()

export type Recipe = "context" | "voice" | "full"

export async function infer(input: {
  current: ModelMessage[]
  evidence: Evidence[]
  statistics: Sketch[]
  model: Provider.Model
  metadata: Record<string, string>
  signal?: AbortSignal
  recipe?: Recipe
  onPrepared?(evidence: Evidence[]): Promise<void>
}) {
  const recipe = input.recipe ?? "full"
  const current = JSON.stringify(input.current)
  const contextText = await SecretMask.apply(current)
  const maxOutputTokens = Math.min(input.model.limit.output, 16_384)
  const available = Math.min(input.model.limit.input ?? Infinity, input.model.limit.context - maxOutputTokens)
  const statistics = sketch([])
  for (const value of recipe === "context" ? [] : input.statistics) {
    for (const field of ["count", "characters", "han", "latin", "questions", "commas", "newlines"] as const)
      statistics[field] += value[field]
    statistics.lengths = statistics.lengths.map((count, index) => count + value.lengths[index]!)
  }
  const outputSchema = (evidence: Evidence[]) =>
    z.toJSONSchema(
      Prediction.extend({
        grounding: z
          .enum(["current", ...evidence.map((value) => value.id)])
          .array()
          .min(1)
          .describe(Prediction.shape.grounding.description!),
      }),
      { target: "draft-7" },
    ) as JSONSchema7
  let schema = outputSchema(input.evidence)
  const payload = {
    current: { id: "current", conversation: JSON.parse(contextText) },
    historicalObservations: [] as Array<Pick<Evidence, "id" | "kind" | "previous" | "text">>,
    numericVoiceObservations: recipe === "context" ? [] : [statistics],
  }
  let used = await Token.estimateModel(input.model.id, prompt + JSON.stringify({ payload, schema }))
  if (available <= 0 || used >= available)
    throw new AgentCall.Error("input_too_large", "The completed context exceeds the selected model capacity")
  const selected: Evidence[] = []
  for (const evidence of recipe === "context" ? [] : input.evidence) {
    if (recipe === "voice" && evidence.kind !== "voice") continue
    const tokens = await Token.estimateModelJSON(input.model.id, {
      id: evidence.id,
      kind: evidence.kind,
      previous: evidence.previous,
      text: evidence.text,
    })
    if (used + tokens > available * 0.95) continue
    selected.push(evidence)
    used += tokens
  }
  payload.historicalObservations = selected.map(({ id, kind, previous, text }) => ({ id, kind, previous, text }))
  schema = outputSchema(selected)
  const messages: ModelMessage[] = [{ role: "user", content: await SecretMask.apply(JSON.stringify(payload)) }]
  await input.onPrepared?.(selected)
  const started = performance.now()
  const output = await AgentCall.text({
    agent: "digital-twin",
    ownership: "operation",
    messages,
    model: input.model,
    small: false,
    userMetadata: input.metadata,
    signal: input.signal,
    timeoutMs: 180_000,
    retries: 2,
    maxOutputTokens,
    maxOutputChars: maxOutputTokens * 8,
    outputTool: {
      name: "predict_next_input",
      force: false,
      description: "Return one grounded editable next user message or abstain.",
      schema,
    },
  })
  const call = output.toolCalls?.filter((call) => call.name === "predict_next_input")
  const parsed = call?.length === 1 ? Prediction.safeParse(call[0]!.input) : undefined
  if (!parsed?.success) throw new PredictionError("invalid_prediction", "The model did not return a valid prediction")
  const prediction = parsed.data
  const allowed = new Set(["current", ...selected.map((evidence) => evidence.id)])
  if (
    !prediction.grounding.includes("current") ||
    prediction.grounding.some((id) => !allowed.has(id)) ||
    prediction.targets.some((target) => !contextText.includes(target)) ||
    Boolean(prediction.candidate) === Boolean(prediction.abstention)
  )
    throw new PredictionError("invalid_prediction", "The prediction contains ungrounded references or targets")
  if (
    prediction.candidate &&
    (/⟦sec:/.test(prediction.candidate) || (await SecretMask.apply(prediction.candidate)) !== prediction.candidate)
  )
    throw new PredictionError("invalid_prediction", "The prediction contains protected content")
  return { prediction, selected, usage: output.usage, elapsedMs: performance.now() - started }
}

export class PredictionError extends Error {
  constructor(
    readonly code: z.infer<typeof DigitalTwinContract.Failure>["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "DigitalTwinError"
  }
}
