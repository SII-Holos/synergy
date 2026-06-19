import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import type { Info } from "./types"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { LLM } from "./llm"
import { iife } from "../util/iife"
import { LoopJob } from "./loop-job"
import { Turn } from "./turn"

const log = Log.create({ service: "session.title" })

const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

export function createDefaultTitle(isChild = false) {
  return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
}

export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
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
  async execute(ctx) {
    await ensureTitle({
      session: ctx.session,
      modelID: ctx.lastUser.model.modelID,
      providerID: ctx.lastUser.model.providerID,
      history: ctx.messages,
    })
    return "pass"
  },
})

export async function ensureTitle(input: {
  session: Info
  history: MessageV2.WithParts[]
  providerID: string
  modelID: string
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
  const result = await LLM.stream({
    agent,
    user: firstRealUser.info as MessageV2.User,
    system: [],
    small: true,
    tools: {},
    model: await iife(async () => {
      const agentModel = await Agent.getAvailableModel(agent)
      if (agentModel) return await Provider.getModel(agentModel.providerID, agentModel.modelID)
      return await Provider.getModel(input.providerID, input.modelID)
    }),
    abort: new AbortController().signal,
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
  const text = await result.text.catch((err) => log.error("failed to generate title", { error: err }))
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
