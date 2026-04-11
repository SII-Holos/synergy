import z from "zod"
import { MessageV2 } from "../session/message-v2"
import { Session } from "../session"
import { Scope } from "../scope"
import { Turn } from "../session/turn"
import { Token } from "../util/token"

export namespace TurnDigest {
  const DEFAULT_TOOL_OUTPUT_BUDGET = 800

  export interface Options {
    toolOutputBudget?: number
  }

  export const TextSegment = z
    .object({
      type: z.literal("text"),
      text: z.string(),
    })
    .meta({ ref: "TurnDigestTextSegment" })

  export const ReasoningSegment = z
    .object({
      type: z.literal("reasoning"),
      text: z.string(),
    })
    .meta({ ref: "TurnDigestReasoningSegment" })

  export const ToolSegment = z
    .object({
      type: z.literal("tool"),
      tool: z.string(),
      title: z.string(),
      status: z.enum(["completed", "error"]),
      input: z.record(z.string(), z.any()).optional(),
      output: z.string(),
    })
    .meta({ ref: "TurnDigestToolSegment" })

  export const PatchSegment = z
    .object({
      type: z.literal("patch"),
      files: z.string().array(),
    })
    .meta({ ref: "TurnDigestPatchSegment" })

  export const StepBoundarySegment = z
    .object({
      type: z.literal("step-boundary"),
      reason: z.string(),
      cost: z.number(),
    })
    .meta({ ref: "TurnDigestStepBoundarySegment" })

  export const Segment = z
    .discriminatedUnion("type", [TextSegment, ReasoningSegment, ToolSegment, PatchSegment, StepBoundarySegment])
    .meta({ ref: "TurnDigestSegment" })
  export type Segment = z.infer<typeof Segment>

  export const ChannelMeta = z
    .object({
      type: z.string(),
      accountId: z.string(),
      chatId: z.string(),
      senderId: z.string(),
    })
    .meta({ ref: "TurnDigestChannelMeta" })
  export type ChannelMeta = z.infer<typeof ChannelMeta>

  export const Info = z
    .object({
      id: z.string(),
      sessionID: z.string(),
      scopeID: z.string(),
      input: z.string(),
      segments: Segment.array(),
      changes: z.object({
        files: z.string().array(),
        additions: z.number(),
        deletions: z.number(),
      }),
      body: z.string().optional(),
      agent: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      tokens: z.object({
        input: z.number(),
        output: z.number(),
        reasoning: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
      }),
      cost: z.number(),
      time: z.object({
        start: z.number(),
        end: z.number(),
      }),
      channel: ChannelMeta.optional(),
    })
    .meta({ ref: "TurnDigest" })
  export type Info = z.infer<typeof Info>

  function fromTurn(session: Session.Info, turn: Turn.Raw, options?: Options): Info {
    return build(session, turn.user, turn.assistants, options)
  }

  export async function extract(sessionID: string, options?: Options): Promise<Info[]> {
    const session = await Session.get(sessionID)
    const msgs = await Session.messages({ sessionID })
    const turns = Turn.collect(msgs)
    return turns.filter((turn) => turn.assistants.length > 0).map((turn) => fromTurn(session, turn, options))
  }

  export interface ExtractedTurn {
    digest: Info
    turn: Turn.Raw
  }

  export async function extractSingle(
    sessionID: string,
    userMessageID: string,
    options?: Options,
  ): Promise<ExtractedTurn | undefined> {
    const session = await Session.get(sessionID)
    const msgs = await Session.messages({ sessionID })

    const rootID = Turn.resolveRealUser(msgs, userMessageID)
    const turn = rootID === userMessageID ? Turn.collectOne(msgs, userMessageID) : collectChain(msgs, rootID)
    if (!turn) return undefined
    if (turn.assistants.length === 0) return undefined
    return { digest: fromTurn(session, turn, options), turn }
  }

  function collectChain(msgs: MessageV2.WithParts[], rootUserID: string): Turn.Raw | undefined {
    const rootIdx = msgs.findIndex((m) => m.info.id === rootUserID && m.info.role === "user")
    if (rootIdx < 0) return undefined

    const user = msgs[rootIdx]
    const assistants: MessageV2.WithParts[] = []

    for (let i = rootIdx + 1; i < msgs.length; i++) {
      const msg = msgs[i]
      if (msg.info.role === "user" && !Turn.isSyntheticUser(msg)) break
      if (msg.info.role === "assistant") assistants.push(msg)
    }

    return { user, assistants }
  }

  export function renderToText(digest: Info): string {
    const parts: string[] = []
    if (digest.input) parts.push(`### User\n${digest.input}`)
    const rendered = digest.segments.map(renderSegmentToText).filter(Boolean)
    if (rendered.length > 0) parts.push(`### Response\n${rendered.join("\n\n")}`)
    if (digest.changes.files.length > 0) {
      parts.push(
        `### Changes\nModified: ${digest.changes.files.join(", ")}` +
          `\n+${digest.changes.additions} -${digest.changes.deletions} lines`,
      )
    }
    if (digest.body) parts.push(`### Summary\n${digest.body}`)
    return parts.join("\n\n")
  }

  function build(
    session: Session.Info,
    userMsg: MessageV2.WithParts,
    assistants: MessageV2.WithParts[],
    options?: Options,
  ): Info {
    const userInfo = userMsg.info as MessageV2.User
    const input = extractUserInput(userMsg)
    const segments = buildSegments(assistants, options)

    const tokens = aggregateTokens(assistants)
    const cost = assistants.reduce((sum, m) => {
      if (m.info.role === "assistant") return sum + m.info.cost
      return sum
    }, 0)
    const changes = extractChanges(userMsg, assistants)

    const lastAssistant = assistants.at(-1)
    const endTime =
      lastAssistant?.info.role === "assistant" ? (lastAssistant.info.time.completed ?? Date.now()) : Date.now()

    const body = userInfo.summary?.body

    return {
      id: userInfo.id,
      sessionID: session.id,
      scopeID: (session.scope as Scope).id,
      input,
      segments,
      changes,
      body,
      agent: userInfo.agent,
      model: userInfo.model,
      tokens,
      cost,
      time: {
        start: userInfo.time.created,
        end: endTime,
      },
    }
  }

  function extractUserInput(msg: MessageV2.WithParts): string {
    return msg.parts
      .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic)
      .map((p) => p.text)
      .join("\n")
  }

  function buildSegments(msgs: MessageV2.WithParts[], options?: Options): Segment[] {
    const segments: Segment[] = []
    const budget = options?.toolOutputBudget ?? DEFAULT_TOOL_OUTPUT_BUDGET

    for (const msg of msgs) {
      if (msg.info.role === "user") continue
      for (const part of msg.parts) {
        const segment = partToSegment(part, budget)
        if (segment) segments.push(segment)
      }
    }

    return segments
  }

  function partToSegment(part: MessageV2.Part, toolOutputBudget: number): Segment | undefined {
    switch (part.type) {
      case "text":
        if (part.synthetic) return undefined
        if (!part.text.trim()) return undefined
        return { type: "text", text: part.text }

      case "reasoning":
        if (!part.text.trim()) return undefined
        return { type: "reasoning", text: part.text }

      case "tool":
        return toolPartToSegment(part, toolOutputBudget)

      case "patch":
        if (part.files.length === 0) return undefined
        return { type: "patch", files: part.files }

      case "step-finish":
        return {
          type: "step-boundary",
          reason: part.reason,
          cost: part.cost,
        }

      default:
        return undefined
    }
  }

  function toolPartToSegment(part: MessageV2.ToolPart, toolOutputBudget: number): Segment | undefined {
    if (part.state.status === "pending" || part.state.status === "running") return undefined

    if (part.state.status === "completed") {
      return {
        type: "tool",
        tool: part.tool,
        title: part.state.title,
        status: "completed",
        input: part.state.input,
        output: truncate(part.state.output, toolOutputBudget),
      }
    }

    if (part.state.status === "error") {
      return {
        type: "tool",
        tool: part.tool,
        title: "",
        status: "error",
        input: part.state.input,
        output: part.state.error,
      }
    }

    return undefined
  }

  function aggregateTokens(msgs: MessageV2.WithParts[]): Info["tokens"] {
    const result = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    for (const msg of msgs) {
      if (msg.info.role !== "assistant") continue
      result.input += msg.info.tokens.input
      result.output += msg.info.tokens.output
      result.reasoning += msg.info.tokens.reasoning
      result.cache.read += msg.info.tokens.cache.read
      result.cache.write += msg.info.tokens.cache.write
    }
    return result
  }

  function extractChanges(userMsg: MessageV2.WithParts, assistants: MessageV2.WithParts[]): Info["changes"] {
    const files = new Set<string>()
    let additions = 0
    let deletions = 0

    for (const msg of assistants) {
      for (const part of msg.parts) {
        if (part.type === "patch") {
          for (const f of part.files) files.add(f)
        }
      }
    }

    const userInfo = userMsg.info as MessageV2.User
    if (userInfo.summary?.diffs) {
      for (const diff of userInfo.summary.diffs) {
        additions += diff.additions
        deletions += diff.deletions
      }
    }

    return {
      files: [...files],
      additions,
      deletions,
    }
  }

  function truncate(text: string, tokenBudget: number): string {
    const estimated = Token.estimate(text)
    if (estimated <= tokenBudget) return text
    const charBudget = tokenBudget * 4
    return text.slice(0, charBudget) + "\n... [truncated]"
  }

  function renderSegmentToText(segment: Segment): string {
    switch (segment.type) {
      case "text":
        return segment.text
      case "reasoning":
        return `[Thinking] ${segment.text}`
      case "tool":
        if (segment.status === "error") {
          return `[Tool: ${segment.tool}] Error: ${segment.output}`
        }
        return `[Tool: ${segment.tool}] ${segment.title}${segment.output ? "\n  → " + segment.output.split("\n")[0] : ""}`
      case "patch":
        return `[Changed] ${segment.files.join(", ")}`
      case "step-boundary":
        return ""
    }
  }
}
