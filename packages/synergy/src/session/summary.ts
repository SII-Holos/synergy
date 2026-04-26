import { Provider } from "@/provider/provider"

import { fn } from "@/util/fn"
import z from "zod"
import { Session } from "."
import { SessionEvent } from "./event"

import { MessageV2 } from "./message-v2"
import { Identifier } from "@/id/id"
import { Snapshot } from "@/session/snapshot"

import { Log } from "@/util/log"
import path from "path"
import { SessionManager } from "./manager"
import { Scope } from "@/scope"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Bus } from "@/bus"

import { LLM } from "./llm"
import { Agent } from "@/agent/agent"
import { Turn } from "./turn"
import { LoopJob } from "./loop-job"

export namespace SessionSummary {
  const log = Log.create({ service: "session.summary" })
  const { asScopeID, asSessionID, asMessageID } = Identifier

  export const summarize = fn(
    z.object({
      sessionID: z.string(),
      messageID: z.string(),
    }),
    async (input) => {
      const all = await Session.messages({ sessionID: input.sessionID })
      await Promise.all([
        summarizeSession({ sessionID: input.sessionID, messages: all }),
        summarizeMessage({ messageID: input.messageID, messages: all }),
      ])
    },
  )

  async function summarizeSession(input: { sessionID: string; messages: MessageV2.WithParts[] }) {
    const session = await SessionManager.requireSession(input.sessionID)
    const directory = (session.scope as Scope).directory
    const scopeID = asScopeID((session.scope as Scope).id)
    const files = new Set(
      input.messages
        .flatMap((x) => x.parts)
        .filter((x) => x.type === "patch")
        .flatMap((x) => x.files)
        .map((x) => path.relative(directory, x)),
    )
    const diffs = await computeDiff({ messages: input.messages }).then((x) =>
      x.filter((x) => {
        return files.has(x.file)
      }),
    )
    await Session.update(input.sessionID, (draft) => {
      draft.summary = {
        additions: diffs.reduce((sum, x) => sum + x.additions, 0),
        deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
        files: diffs.length,
      }
    })
    await Storage.write(StoragePath.sessionSummary(scopeID, asSessionID(input.sessionID)), diffs)
    Bus.publish(SessionEvent.Diff, {
      sessionID: input.sessionID,
      diff: diffs,
    })
  }

  async function saveSummary(userMsg: MessageV2.User) {
    const session = await SessionManager.requireSession(userMsg.sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    const fresh = await Storage.read<MessageV2.User>(
      StoragePath.messageInfo(scopeID, asSessionID(userMsg.sessionID), asMessageID(userMsg.id)),
    )
    if (fresh) {
      fresh.summary = userMsg.summary
      await Session.updateMessage(fresh)
    } else {
      await Session.updateMessage(userMsg)
    }
  }

  async function summarizeMessage(input: { messageID: string; messages: MessageV2.WithParts[] }) {
    const turn = Turn.collectOne(input.messages, input.messageID)
    if (!turn) return
    const messages = [turn.user, ...turn.assistants]
    const msgWithParts = turn.user
    const userMsg = msgWithParts.info as MessageV2.User
    const diffs = await computeDiff({ messages })
    userMsg.summary = {
      ...userMsg.summary,
      diffs,
    }

    const assistantMsg = messages.find((m) => m.info.role === "assistant")?.info as MessageV2.Assistant | undefined
    if (!assistantMsg) {
      await saveSummary(userMsg)
      return
    }

    const fallbackModel = await Provider.getModel(assistantMsg.providerID, assistantMsg.modelID)

    const textPart = msgWithParts.parts.find((p) => p.type === "text" && !p.synthetic) as MessageV2.TextPart | undefined
    const hasStepFinish = messages.some(
      (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "step-finish" && p.reason !== "tool-calls"),
    )
    const needsBody = hasStepFinish && diffs.length > 0
    const needsTitle = textPart && !userMsg.summary?.title

    const generateTitle = async (): Promise<string | undefined> => {
      if (!needsTitle || !textPart) return undefined
      const agent = await Agent.get("title")
      const agentModel = await Agent.getAvailableModel(agent)
      const stream = await LLM.stream({
        agent,
        user: userMsg,
        tools: {},
        model: agentModel ? await Provider.getModel(agentModel.providerID, agentModel.modelID) : fallbackModel,
        small: true,
        messages: [
          {
            role: "user" as const,
            content: `The following is the text to summarize:\n<text>\n${textPart.text ?? ""}\n</text>`,
          },
        ],
        abort: new AbortController().signal,
        sessionID: userMsg.sessionID,
        system: [],
        retries: 3,
      })
      const result = await stream.text.catch((err) => {
        log.error("failed to generate summary title", { error: err })
        return undefined
      })
      if (result) log.info("title", { title: result })
      return result
    }

    const generateBody = async (): Promise<string | undefined> => {
      if (!needsBody) return undefined
      const prunedMessages = structuredClone(messages)
      for (const msg of prunedMessages) {
        for (const part of msg.parts) {
          if (part.type === "tool" && part.state.status === "completed") {
            part.state.output = "[TOOL OUTPUT PRUNED]"
          }
        }
      }
      const summaryAgent = await Agent.get("summary")
      const summaryAgentModel = await Agent.getAvailableModel(summaryAgent)
      const stream = await LLM.stream({
        agent: summaryAgent,
        user: userMsg,
        tools: {},
        model: summaryAgentModel
          ? await Provider.getModel(summaryAgentModel.providerID, summaryAgentModel.modelID)
          : fallbackModel,
        small: true,
        messages: [
          ...MessageV2.toModelMessage(prunedMessages),
          {
            role: "user" as const,
            content: `Summarize the above conversation according to your system prompts.`,
          },
        ],
        abort: new AbortController().signal,
        sessionID: userMsg.sessionID,
        system: [],
        retries: 3,
      })
      return stream.text.catch((err) => {
        log.error("failed to generate summary body", { error: err })
        return undefined
      })
    }

    const [title, body] = await Promise.all([generateTitle(), generateBody()])

    if (title) userMsg.summary.title = title
    if (body) userMsg.summary.body = body
    await saveSummary(userMsg)
  }

  export const diff = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message").optional(),
    }),
    async (input) => {
      const session = await SessionManager.requireSession(input.sessionID)
      const scopeID = asScopeID((session.scope as Scope).id)
      return Storage.read<Snapshot.FileDiff[]>(StoragePath.sessionSummary(scopeID, asSessionID(input.sessionID))).catch(
        () => [],
      )
    },
  )

  async function computeDiff(input: { messages: MessageV2.WithParts[] }) {
    let from: string | undefined
    let to: string | undefined

    // scan assistant messages to find earliest from and latest to
    // snapshot
    for (const item of input.messages) {
      if (!from) {
        for (const part of item.parts) {
          if (part.type === "step-start" && part.snapshot) {
            from = part.snapshot
            break
          }
        }
      }

      for (const part of item.parts) {
        if (part.type === "step-finish" && part.snapshot) {
          to = part.snapshot
          break
        }
      }
    }

    if (from && to) return Snapshot.diffFull(from, to)
    return []
  }
}

LoopJob.register({
  type: "summarize",
  phase: "pre",
  blocking: false,
  collect(ctx) {
    if (ctx.step !== 1) return []
    return [{ type: "summarize" }]
  },
  async execute(ctx) {
    await SessionSummary.summarize({
      sessionID: ctx.sessionID,
      messageID: ctx.lastUser.id,
    })
    return "pass"
  },
})
