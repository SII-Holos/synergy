import { MessageV2 } from "./message-v2"
import { formatLocalDateTime } from "../util/time-format"
import { Log } from "../util/log"
import type { Info } from "./types"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { AgentTurn } from "./agent-turn"
import { iife } from "../util/iife"
import { LoopJob } from "./loop-job"
import { Turn } from "./turn"
import { SessionHistory } from "./history"

const log = Log.create({ service: "session.title" })

const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

export function createDefaultTitle(isChild = false) {
  return (isChild ? childTitlePrefix : parentTitlePrefix) + formatLocalDateTime(Date.now())
}

export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}\\s\\d{2}:\\d{2}:\\d{2}\\s\\(UTC[+-]\\d{2}:\\d{2}\\)$`,
  ).test(title)
}

LoopJob.register({
  type: "ensure-title",
  phase: "pre",
  blocking: false,
  collect(ctx) {
    if (ctx.step !== 1) return []
    return [{ type: "ensure-title" }]
  },
  capture(ctx) {
    return {
      type: "ensure-title",
      sessionID: ctx.sessionID,
      modelID: ctx.lastUser.model.modelID,
      providerID: ctx.lastUser.model.providerID,
    }
  },
  key(input) {
    return input.sessionID
  },
  timeoutMs: 120_000,
  async execute(input, signal) {
    const { Session } = await import(".")
    const [session, history] = await Promise.all([
      Session.get(input.sessionID),
      SessionHistory.detachedModelMessages({ sessionID: input.sessionID, signal }),
    ])
    await ensureTitle({
      session,
      modelID: input.modelID,
      providerID: input.providerID,
      history,
      abort: signal,
    })
    return "pass"
  },
})

export async function ensureTitle(input: {
  session: Info
  history: MessageV2.WithParts[]
  providerID: string
  modelID: string
  abort: AbortSignal
}) {
  if (input.session.parentID) return
  if (!isDefaultTitle(input.session.title)) return

  const promptVisibleUsers = input.history.filter((m) => m.info.role === "user" && !Turn.isSyntheticUser(m))
  if (promptVisibleUsers.length !== 1) return

  const firstRealUser = promptVisibleUsers[0]
  const firstRealUserIdx = input.history.findIndex((m) => m.info.id === firstRealUser.info.id)
  if (firstRealUserIdx === -1) return

  // Gather all prompt-visible context up to and including the first real user message.
  const contextMessages = input.history.slice(0, firstRealUserIdx + 1).filter(MessageV2.isPromptVisible)

  const agent = await Agent.get("title")
  if (!agent) return
  const result = await AgentTurn.stream({
    agent,
    user: firstRealUser.info as MessageV2.User,
    system: [],
    small: true,
    toolDefinitions: [],
    model: await iife(async () => {
      const agentModel = await Agent.getAvailableModel(agent)
      if (agentModel) return await Provider.getModel(agentModel.providerID, agentModel.modelID)
      return await Provider.getModel(input.providerID, input.modelID)
    }),
    abort: input.abort,
    sessionID: input.session.id,
    retries: 2,
    messages: [
      {
        role: "user",
        content: "Generate a title for this conversation:\n",
      },
      ...MessageV2.toModelMessage(contextMessages),
    ],
  })
  const text = await AgentTurn.collectText(result).catch((err) => log.error("failed to generate title", { error: err }))
  if (text) {
    const { Session } = await import(".")
    return Session.update(input.session.id, (draft) => {
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return

      const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      draft.title = title
    })
  }
}
