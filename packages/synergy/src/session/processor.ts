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
import { ExperienceEncoder } from "@/library/experience-encoder"
import { Question } from "@/question"
import { ToolTimeout } from "@/tool/timeout"
import { Observability } from "@/observability"
import { ToolDiagnostic } from "@/tool/diagnostic"

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
    | { status: "error"; input: any; error: string; metadata?: Record<string, any> }

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

  export function streamToolErrorOutcome(part: MessageV2.ToolPart, error: unknown): ToolOutcome {
    const rawMessage = error instanceof Error ? error.message : String(error)
    const errorName = error instanceof Error ? error.name : undefined
    const unavailable = /unavailable tool|no such tool|tool .* not found|unknown tool/i.test(rawMessage)
    const diagnostic = {
      code: unavailable ? "unknown_tool" : "invalid_arguments",
      toolName: part.tool,
      message: unavailable
        ? [
            `The model tried to call unavailable tool "${part.tool}".`,
            "This tool is not available in the current session, mode, or permission context. Do not retry the same hidden tool.",
            rawMessage,
          ].join("\n")
        : [
            `The "${part.tool}" tool call could not be accepted.`,
            "Rewrite the tool input so it satisfies the current schema, or choose another available tool.",
            rawMessage,
          ].join("\n"),
      metadata: {
        source: "ai_sdk_tool_error",
        errorName,
        rawMessage,
      },
    } satisfies ToolDiagnostic

    return {
      status: "error",
      input:
        part.state.status === "running" || part.state.status === "pending" || part.state.status === "generating"
          ? part.state.input
          : {},
      error: diagnostic.message,
      metadata: ToolDiagnostic.metadata(diagnostic),
    }
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

    function toolStartTime(part: MessageV2.ToolPart, fallback = Date.now()) {
      if (part.state.status !== "running") return fallback
      const approval = (part.state.metadata as any)?.approval
      const executionStartedAt = approval?.time?.executionStartedAt
      if (typeof executionStartedAt === "number") return executionStartedAt
      if (
        approval?.status === "pending_user" ||
        approval?.status === "user_denied" ||
        approval?.status === "auto_denied" ||
        approval?.status === "policy_denied"
      ) {
        return fallback
      }
      return part.state.time.start
    }

    async function settleToolPart(part: MessageV2.ToolPart, outcome: ToolOutcome) {
      const startTime = toolStartTime(part)
      await Observability.emit("tool.settle.start", {
        sessionID: input.sessionID,
        messageID: input.assistantMessage.id,
        callID: part.callID,
        tool: part.tool,
        data: {
          status: outcome.status,
        },
      })
      if (outcome.status === "completed") {
        await Session.updatePart({
          ...part,
          state: {
            status: "completed",
            input: outcome.input,
            output: outcome.result.output,
            metadata: ToolTimeout.preserveMetadata(
              part.state.status === "running" ? part.state.metadata : undefined,
              outcome.result.metadata,
            )!,
            title: outcome.result.title,
            time: { start: startTime, end: Date.now() },
            attachments: outcome.result.attachments,
          },
        })
      } else {
        await Session.updatePart({
          ...part,
          state: {
            status: "error",
            input: outcome.input,
            error: outcome.error,
            metadata: ToolTimeout.preserveMetadata(
              part.state.status === "running" ? part.state.metadata : undefined,
              outcome.metadata,
            ),
            time: { start: startTime, end: Date.now() },
          },
        })
      }
      await Observability.emit("tool.settle.end", {
        sessionID: input.sessionID,
        messageID: input.assistantMessage.id,
        callID: part.callID,
        tool: part.tool,
        level: outcome.status === "error" ? "error" : "info",
        data: {
          status: outcome.status,
        },
      })
    }

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
        const turnTraceId = Observability.traceId("turn")
        const turnStartedAt = Date.now()
        await Observability.emit("session.turn.start", {
          traceId: turnTraceId,
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          data: {
            parentID: input.assistantMessage.parentID,
            agent: input.assistantMessage.agent,
            model: input.model.id,
            providerID: input.model.providerID,
          },
        })
        const shouldBreak = (await Config.current()).experimental?.continue_loop_on_deny !== true
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
                      signal: input.abort,
                    })
                  }
                  break
                }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    const pending = pendingExecutions.get(value.toolCallId)
                    const outcome = pending ? await pending : undefined
                    if (outcome) await settleToolPart(match, outcome)
                    pendingExecutions.delete(value.toolCallId)
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    const pending = pendingExecutions.get(value.toolCallId)
                    const outcome = pending ? await pending : streamToolErrorOutcome(match, value.error)
                    await settleToolPart(match, outcome)
                    pendingExecutions.delete(value.toolCallId)
                    delete toolcalls[value.toolCallId]
                  }
                  if (
                    value.error instanceof PermissionNext.RejectedError ||
                    value.error instanceof Question.RejectedError
                  ) {
                    blocked = shouldBreak
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = await Snapshot.track(input.sessionID, input.abort)
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
                    snapshot: await Snapshot.track(input.sessionID, input.abort),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot, input.sessionID, {
                      indexFresh: true,
                      signal: input.abort,
                    })
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
                  }).catch(() => {})
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
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined && attempt < SessionRetry.RETRY_MAX_ATTEMPTS) {
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              await Observability.emit("session.turn.retry", {
                traceId: turnTraceId,
                sessionID: input.sessionID,
                messageID: input.assistantMessage.id,
                level: "warn",
                data: {
                  attempt,
                  delay,
                  retry,
                  error,
                },
              })
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
            await Observability.emit("session.turn.error", {
              traceId: turnTraceId,
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
              level: "error",
              data: {
                error,
              },
            })
            Bus.publish(SessionEvent.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot, input.sessionID, { signal: input.abort })
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
              const outcome = outcomes.get(part.callID)
              if (outcome) {
                await settleToolPart(part, outcome)
              } else {
                const startTime = toolStartTime(part)
                await Session.updatePart({
                  ...part,
                  state: {
                    ...part.state,
                    status: "error",
                    error: "Tool execution aborted",
                    time: {
                      start: startTime,
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
          await Observability.emit("session.turn.end", {
            traceId: turnTraceId,
            sessionID: input.sessionID,
            messageID: input.assistantMessage.id,
            level: input.assistantMessage.error ? "error" : "info",
            data: {
              finish: input.assistantMessage.finish,
              blocked,
              error: input.assistantMessage.error,
              durationMs: Date.now() - turnStartedAt,
              pendingTools: pendingExecutions.size,
            },
          })
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}
