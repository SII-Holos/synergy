import { z } from "zod"
import { modelMessageSchema, type ModelMessage } from "ai"
import { SessionCorpus } from "@ericsanchezok/synergy-harness/session/corpus"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutSnapshot } from "@ericsanchezok/synergy-harness/session/rollout/snapshot"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { RolloutSchema } from "@ericsanchezok/synergy-harness/session/rollout/schema"
import { SecretMask } from "@ericsanchezok/synergy-harness/secrets/mask"
import { original, normalize, diversify, sketch, type Evidence } from "../src/evidence"
import { SessionSearchIndex } from "@ericsanchezok/synergy-harness/session/search-index"
import { ContextSourceSchema } from "@ericsanchezok/synergy-harness/session/context-usage-schema"

const Input = z.object({ message: MessageV2.Info, parts: z.array(MessageV2.Part) })
const Request = z.object({
  messages: z.array(modelMessageSchema),
  contextSources: z.array(ContextSourceSchema).optional(),
})
const Event = z.object({
  type: z.string(),
  id: z.string().optional(),
  text: z.string().optional(),
  finishReason: z.string().optional(),
})

export async function artifactText(owner: RolloutSchema.Owner, ref: RolloutSchema.ArtifactRef) {
  if (ref.status !== "complete" || !ref.sha256) throw new Error("Incomplete immutable artifact")
  const decoder = new TextDecoder()
  let text = ""
  for await (const chunk of RolloutArtifact.read(owner, ref)) text += decoder.decode(chunk, { stream: true })
  return text + decoder.decode()
}

export function terminalText(ndjson: string) {
  const blocks = new Map<string, string>()
  let finished = false
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue
    const event = Event.parse(JSON.parse(line))
    if (["abort", "error", "tool-call"].includes(event.type)) return
    if (event.type === "text-delta" && event.id && event.text)
      blocks.set(event.id, (blocks.get(event.id) ?? "") + event.text)
    if (event.type === "finish-step")
      finished = !!event.finishReason && !["tool-calls", "unknown", "error"].includes(event.finishReason)
  }
  const text = [...blocks.values()].join("\n\n")
  return finished && text.trim() ? text : undefined
}

export function confirmsReply(request: z.infer<typeof Request>, input: z.infer<typeof Input>, reply: string) {
  const parts = input.parts.filter(
    (part): part is MessageV2.TextPart => part.type === "text" && !MessageV2.isSystemPart(part) && !!part.text.trim(),
  )
  if (!parts.length || !request.contextSources) return false
  const indexes = new Set<number>()
  for (const part of parts) {
    const sources = request.contextSources.filter(
      (source) =>
        source.category === "userMessages" &&
        source.precision === "source" &&
        source.messageID === input.message.id &&
        source.partID === part.id,
    )
    if (sources.length !== 1) return false
    const source = sources[0]!
    if (source.path.length !== 2 || source.path[0] !== "messages" || !/^(0|[1-9]\d*)$/.test(source.path[1]!))
      return false
    const index = Number(source.path[1])
    const message = request.messages[index]
    if (!message || message.role !== "user") return false
    const selector = source.selector
    let value: string | undefined
    if (selector?.length === 1 && selector[0] === "content" && typeof message.content === "string")
      value = message.content
    if (
      selector?.length === 3 &&
      selector[0] === "content" &&
      selector[2] === "text" &&
      /^(0|[1-9]\d*)$/.test(selector[1]!) &&
      Array.isArray(message.content)
    ) {
      const content = message.content[Number(selector[1])]
      if (content?.type === "text") value = content.text
    }
    if (value === undefined) return false
    if (source.range) {
      if (source.range.start > source.range.end || source.range.end > value.length) return false
      value = value.slice(source.range.start, source.range.end)
    }
    if (value !== part.text) return false
    indexes.add(index)
  }
  if (indexes.size !== 1) return false
  const target = [...indexes][0]!
  const text = (message: ModelMessage) =>
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n\n")
  const preceding = request.messages.slice(0, target).findLast((message) => message.role === "assistant")
  return !!preceding && text(preceding).trim() === reply.trim()
}

export type HistoricalInput = {
  id: string
  sessionID: string
  family: string
  at: number
  text: string
  input: RolloutSchema.ArtifactRef
  revision: number
  preceding?: { reply: string; at: number; verification?: RolloutSchema.ArtifactRef }
}
export type ReplayCase = {
  id: string
  family: string
  sessionID: string
  cutoff: number
  current: ModelMessage[]
  reply: string
  reference: string
  sources: { previous: HistoricalInput; target: HistoricalInput; call: RolloutSchema.CallRecord }
}

export async function historySourceHash() {
  const sources = await Promise.all(
    [
      "./history.ts",
      "../src/evidence.ts",
      "../../harness/src/session/message-v2.ts",
      "../../harness/src/session/search-index.ts",
    ].map((file) => Bun.file(new URL(file, import.meta.url)).text()),
  )
  return new Bun.CryptoHasher("sha256").update(sources.join("\n")).digest("hex")
}

export async function loadHistory(progress: (value: object) => void) {
  const history: HistoricalInput[] = []
  const cases: ReplayCase[] = []
  const exclusions: Record<string, number> = {}
  const exclude = (reason: string) => (exclusions[reason] = (exclusions[reason] ?? 0) + 1)
  let cursor: string[] | undefined
  let sessions = 0
  do {
    const page = await SessionCorpus.sessions({ cursor, limit: 32 })
    cursor = page.cursor
    for (const session of page.items) {
      sessions++
      progress({ stage: "history", sessions, inputs: history.length, cases: cases.length, exclusions })
      if (session.parentID || session.forkedFrom) {
        exclude("child_or_fork_session")
        continue
      }
      const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
      let snapshot: RolloutSnapshot.Info
      try {
        snapshot = await RolloutSnapshot.read(owner)
      } catch {
        exclude("unavailable_journal")
        continue
      }
      if (snapshot.gaps.length) {
        exclude("journal_gaps")
        continue
      }
      if (!snapshot.runs.length) {
        exclude("no_immutable_runs")
        continue
      }
      let previous:
        | {
            input: HistoricalInput
            completed: { at: number; current: ModelMessage[]; reply: string; call: RolloutSchema.CallRecord }
          }
        | undefined
      for (const run of snapshot.runs.toSorted((a, b) => a.started - b.started)) {
        const preceding = previous
        previous = undefined
        if (run.source || run.parent || !run.input || run.input.status !== "complete") {
          exclude("unavailable_original_input")
          continue
        }
        let input: z.infer<typeof Input>
        try {
          input = Input.parse(JSON.parse(await artifactText(owner, run.input)))
          if (input.message.sessionID !== owner.sessionID || (input.message.rootID ?? input.message.id) !== run.id)
            throw new Error("Input identity mismatch")
        } catch {
          exclude("invalid_original_input")
          continue
        }
        const text = original({ info: input.message, parts: input.parts })
        if (!text || (await SecretMask.apply(text)) !== text) {
          exclude("non_original_or_contaminated_input")
          continue
        }
        const calls = snapshot.calls
          .filter((call) => call.runID === run.id && call.usageRole === "conversation")
          .toSorted((a, b) => a.started - b.started)
        if (!calls[0]) {
          exclude("no_recorded_input_time")
          continue
        }
        const item: HistoricalInput = {
          id: `${session.id}/${run.id}`,
          sessionID: session.id,
          family: session.id,
          at: Math.max(input.message.time.created, calls[0].started),
          text,
          input: run.input,
          revision: snapshot.revision,
        }
        history.push(item)
        if (
          preceding?.completed &&
          preceding.completed.at < run.started &&
          preceding.completed.at < input.message.time.created
        ) {
          const first = calls[0]
          try {
            if (!first || first.source) throw new Error("Original subsequent request unavailable")
            const request = Request.parse(JSON.parse(await artifactText(owner, first.request)))
            if (!confirmsReply(request, input, preceding.completed.reply))
              throw new Error("Displayed reply cannot be verified")
            item.preceding = {
              reply: preceding.completed.reply,
              at: preceding.completed.at,
              verification: first.request,
            }
            cases.push({
              id: item.id,
              sessionID: session.id,
              family: session.id,
              cutoff: preceding.completed.at,
              current: preceding.completed.current,
              reply: preceding.completed.reply,
              reference: text,
              sources: { previous: preceding.input, target: item, call: preceding.completed.call },
            })
          } catch {
            exclude("unverified_preceding_reply")
          }
        } else exclude("no_immediately_completed_predecessor")
        if (run.status !== "completed" || run.recording === "failed" || run.cancelRequestedAt || !run.ended) {
          exclude("incomplete_root")
          continue
        }
        const call = calls.at(-1)
        if (
          !call ||
          call.source ||
          call.status !== "completed" ||
          !call.response ||
          call.request.status !== "complete" ||
          call.response.status !== "complete" ||
          !call.ended ||
          call.ended > run.ended
        ) {
          exclude("unavailable_terminal_call")
          continue
        }
        try {
          const request = Request.parse(JSON.parse(await artifactText(owner, call.request)))
          const reply = terminalText(await artifactText(owner, call.response))
          if (!reply) {
            exclude("non_terminal_response")
            continue
          }
          previous = {
            input: item,
            completed: {
              at: run.ended,
              reply,
              current: [...request.messages, { role: "assistant", content: reply }],
              call,
            },
          }
        } catch {
          exclude("unavailable_call_artifacts")
        }
      }
      if (sessions % 10 === 0)
        progress({ stage: "history", sessions, inputs: history.length, cases: cases.length, exclusions })
    }
  } while (cursor)
  return { version: 2 as const, sourceHash: await historySourceHash(), history, cases, sessions, exclusions }
}

export function temporalEvidence(item: ReplayCase, history: HistoricalInput[]) {
  const target = normalize(item.reference)
  const tokens = SessionSearchIndex.tokenize(JSON.stringify(item.current))
  const allowed = history.filter(
    (source) => source.at < item.cutoff && source.family !== item.family && normalize(source.text) !== target,
  )
  const unique = diversify(
    allowed.map((source) => ({ ...source, score: source.at })),
    allowed.length,
    Number.MAX_SAFE_INTEGER,
  )
  const examples: Evidence[] = []
  for (const source of unique) {
    const score =
      SessionSearchIndex.overlapScore(source.text, tokens) + 1 / (1 + (item.cutoff - source.at) / 2_592_000_000)
    examples.push({ id: source.id, kind: "voice", text: source.text, family: source.family, score, references: [] })
    if (source.preceding && source.preceding.at < source.at && source.preceding.at < item.cutoff)
      examples.push({
        id: `${source.id}/pair`,
        kind: "continuation",
        text: source.text,
        previous: source.preceding.reply,
        family: source.family,
        score: score + SessionSearchIndex.overlapScore(source.preceding.reply, tokens),
        references: [],
      })
  }
  return {
    evidence: [
      ...diversify(
        examples.filter((example) => example.kind === "continuation"),
        12,
      ),
      ...diversify(
        examples.filter((example) => example.kind === "voice"),
        16,
      ),
    ],
    statistics: [sketch(unique.map((source) => source.text))],
    available: unique.length,
  }
}
