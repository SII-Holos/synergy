import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { SessionEvent } from "./event"
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/session/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionManager } from "./manager"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { PermissionNext } from "@/permission/next"
import { ExperienceEncoder } from "@/engram/experience-encoder"
import { Question } from "@/question"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const TOOL_SETTLE_TIMEOUT = 5_000
  const log = Log.create({ service: "session.processor" })

  export type ToolOutcome =
    | {
        status: "completed"
        input: any
        result: { output: string; title: string; metadata: Record<string, any>; attachments?: MessageV2.FilePart[] }
      }
    | { status: "error"; input: any; error: string }

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function shouldAskDoomLoop(parts: MessageV2.Part[], toolName: string, input: unknown) {
    const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)
    return (
      lastThree.length === DOOM_LOOP_THRESHOLD &&
      lastThree.every(
        (part) =>
          part.type === "tool" &&
          part.tool === toolName &&
          part.state.status !== "pending" &&
          JSON.stringify(part.state.input) === JSON.stringify(input),
      )
    )
  }

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    const pendingExecutions = new Map<string, Promise<ToolOutcome>>()
    const generatingAccum: Record<string, string> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      trackExecution(toolCallId: string, promise: Promise<ToolOutcome>) {
        pendingExecutions.set(toolCallId, promise)
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        while (true) {
          try {
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            const stream = await LLM.stream(streamInput)

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  SessionManager.setStatus(input.sessionID, { type: "busy" })
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  reasoningMap[value.id] = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    if (part.text) await Session.updatePart({ part, delta: value.text })
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start": {
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  generatingAccum[value.id] = ""
                  break
                }

                case "tool-input-delta": {
                  const match = toolcalls[value.id]
                  if (!match) break
                  const prevRaw = generatingAccum[value.id]
                  if (prevRaw === undefined) break
                  const raw = prevRaw + value.delta
                  generatingAccum[value.id] = raw
                  // Throttle generating updates: emit when enough new content has accumulated
                  if (raw.length - (prevRaw.length || 0) < 50 && raw.length % 128 !== 0) break
                  const part = await Session.updatePart({
                    ...match,
                    state: {
                      status: "generating",
                      input: {},
                      raw,
                      charsReceived: raw.length,
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break
                }

                case "tool-input-end": {
                  const match = toolcalls[value.id]
                  if (!match) break
                  const raw = generatingAccum[value.id]
                  if (!raw) break
                  // Final flush: push the complete accumulated raw even if it didn't hit the throttle
                  const part = await Session.updatePart({
                    ...match,
                    state: {
                      status: "generating",
                      input: {},
                      raw,
                      charsReceived: raw.length,
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break
                }

                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  const part = await Session.updatePart({
                    ...(match ?? {
                      id: Identifier.ascending("part"),
                      messageID: input.assistantMessage.id,
                      sessionID: input.assistantMessage.sessionID,
                      type: "tool" as const,
                      callID: value.toolCallId,
                    }),
                    tool: value.toolName,
                    state: {
                      status: "running",
                      input: value.input,
                      time: {
                        start: Date.now(),
                      },
                    },
                    metadata: value.providerMetadata,
                  })
                  toolcalls[value.toolCallId] = part as MessageV2.ToolPart
                  delete generatingAccum[value.toolCallId]

                  if (shouldAskDoomLoop(Object.values(toolcalls), value.toolName, value.input)) {
                    const agent = await Agent.get(input.assistantMessage.agent)
                    const session = await Session.get(input.assistantMessage.sessionID)
                    await PermissionNext.ask({
                      permission: "doom_loop",
                      patterns: [value.toolName],
                      sessionID: input.assistantMessage.sessionID,
                      metadata: {
                        tool: value.toolName,
                        input: value.input,
                        ...PermissionNext.requestMetadata(session),
                      },

                      ruleset: PermissionNext.merge(agent.permission, PermissionNext.sessionRuleset(session)),
                    })
                  }
                  break
                }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })

                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input,
                        error: (value.error as any).toString(),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step":
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot, { indexFresh: true })
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  break

                case "text-start":
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    if (currentText.text)
                      await Session.updatePart({
                        part: currentText,
                        delta: value.text,
                      })
                  }
                  break

                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish":
                  break

                case "abort":
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
            }
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined && attempt < SessionRetry.RETRY_MAX_ATTEMPTS) {
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              SessionManager.setStatus(input.sessionID, {
                type: "retry",
                attempt,
                message: retry,
                next: Date.now() + delay,
              })
              await SessionRetry.sleep(delay, input.abort).catch(() => {})
              continue
            }
            input.assistantMessage.error = error
            Bus.publish(SessionEvent.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts({
            sessionID: input.sessionID,
            messageID: input.assistantMessage.id,
          })
          const outcomes = new Map<string, ToolOutcome>()
          if (pendingExecutions.size > 0) {
            const timeout = new Promise<undefined>((resolve) =>
              setTimeout(() => resolve(undefined), TOOL_SETTLE_TIMEOUT),
            )
            await Promise.allSettled(
              [...pendingExecutions.entries()].map(async ([id, promise]) => {
                const outcome = await Promise.race([promise, timeout])
                if (outcome) outcomes.set(id, outcome)
              }),
            )
          }
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              const startTime = part.state.status === "running" ? part.state.time.start : Date.now()
              const outcome = outcomes.get(part.callID)
              if (outcome?.status === "completed") {
                await Session.updatePart({
                  ...part,
                  state: {
                    status: "completed",
                    input: outcome.input,
                    output: outcome.result.output,
                    metadata: outcome.result.metadata,
                    title: outcome.result.title,
                    time: {
                      start: startTime,
                      end: Date.now(),
                    },
                    attachments: outcome.result.attachments,
                  },
                })
              } else if (outcome?.status === "error") {
                await Session.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    input: outcome.input,
                    error: outcome.error,
                    time: {
                      start: startTime,
                      end: Date.now(),
                    },
                  },
                })
              } else {
                await Session.updatePart({
                  ...part,
                  state: {
                    ...part.state,
                    status: "error",
                    error: "Tool execution aborted",
                    time: {
                      start: Date.now(),
                      end: Date.now(),
                    },
                  },
                })
              }
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          Session.updateLastExchange(input.sessionID).catch((e) =>
            log.warn("failed to update lastExchange", { sessionID: input.sessionID, error: e }),
          )
          ExperienceEncoder.onComplete(input.assistantMessage)
          await Plugin.trigger(
            "session.turn.after",
            {
              sessionID: input.sessionID,
              userMessageID: input.assistantMessage.parentID,
              assistantMessageID: input.assistantMessage.id,
              assistant: input.assistantMessage,
              finish: input.assistantMessage.finish,
              error: input.assistantMessage.error,
            },
            {},
          )
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}
