import { ExternalAgent } from "./bridge"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session"
import { Identifier } from "@/id/id"
import { ScopeContext } from "@/scope/context"
import { Log } from "@/util/log"
import { SessionManager } from "@/session/manager"
import { ExperienceEncoder } from "@/library/experience-encoder"
import { Plugin } from "@/plugin"
import { SessionToolInput } from "@/session/tool-input"
import { Truncate } from "@/tool/truncation"

export namespace ExternalAgentProcessor {
  const log = Log.create({ service: "external-agent.processor" })
  const TOOL_OUTPUT_CHAR_LIMIT = 64_000
  const COMPLETED_TOOL_OUTPUT_MAX_BYTES = 100 * 1024

  function formatAgentLabel(agent: string) {
    return agent
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  }

  export interface Options {
    sessionID: string
    agent: string
    adapter: ExternalAgent.Adapter
    parentID: string
    model: { providerID: string; modelID: string }
    context: ExternalAgent.TurnContext
    approvalDelegate: ExternalAgent.ApprovalDelegate
    abort: AbortSignal
  }

  export async function process(opts: Options): Promise<MessageV2.WithParts> {
    const { sessionID, agent, adapter, parentID, abort, context, approvalDelegate } = opts

    const assistantMessage: MessageV2.Assistant = {
      id: Identifier.ascending("message"),
      role: "assistant",
      sessionID,
      parentID,
      visible: true,
      agent,
      mode: agent,
      path: {
        cwd: ScopeContext.current.directory,
        root: ScopeContext.current.directory,
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: opts.model.modelID,
      providerID: opts.model.providerID,
      time: {
        created: Date.now(),
      },
    }
    await Session.updateMessage(assistantMessage)

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: assistantMessage.id,
      sessionID,
      type: "step-start",
    })

    SessionManager.setStatus(sessionID, {
      type: "busy",
      description: `${formatAgentLabel(agent)} working...`,
    })

    const toolParts = new Map<string, MessageV2.ToolPart>()
    const toolOutputs = new Map<string, string>()
    let textPart: MessageV2.TextPart | undefined
    let reasoningPart: MessageV2.ReasoningPart | undefined

    try {
      for await (const event of adapter.turn({ ...context, messageID: assistantMessage.id }, abort)) {
        if (abort.aborted) break

        switch (event.type) {
          case "text_delta": {
            if (!textPart) {
              textPart = {
                id: Identifier.ascending("part"),
                messageID: assistantMessage.id,
                sessionID,
                type: "text",
                text: "",
                time: { start: Date.now() },
              }
            }
            textPart.text += event.text
            await Session.updatePartDelta(textPart, event.text)
            break
          }

          case "reasoning_delta": {
            if (!reasoningPart) {
              reasoningPart = {
                id: Identifier.ascending("part"),
                messageID: assistantMessage.id,
                sessionID,
                type: "reasoning",
                text: "",
                time: { start: Date.now() },
              }
            }
            reasoningPart.text += event.text
            await Session.updatePartDelta(reasoningPart, event.text)
            break
          }

          case "tool_start": {
            const part = (await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: assistantMessage.id,
              sessionID,
              type: "tool",
              tool: event.name,
              callID: event.id,
              state: {
                status: "running",
                input: SessionToolInput.normalize(event.input),
                time: { start: Date.now() },
              },
            })) as MessageV2.ToolPart
            toolParts.set(event.id, part)
            await finalizeTextPart(textPart)
            textPart = undefined
            await finalizeReasoningPart(reasoningPart)
            reasoningPart = undefined
            break
          }

          case "tool_output": {
            const existing = toolOutputs.get(event.id) ?? ""
            const combined = existing + event.output
            toolOutputs.set(
              event.id,
              combined.length > TOOL_OUTPUT_CHAR_LIMIT ? combined.slice(-TOOL_OUTPUT_CHAR_LIMIT) : combined,
            )
            break
          }

          case "tool_end": {
            const part = toolParts.get(event.id)
            if (!part) break
            const startTime = part.state.status === "running" ? part.state.time.start : Date.now()
            const bufferedOutput = toolOutputs.get(event.id) ?? ""
            toolOutputs.delete(event.id)
            if (event.error) {
              await Session.updatePart({
                ...part,
                state: {
                  status: "error",
                  input: part.state.status === "running" ? part.state.input : {},
                  error: event.error,
                  time: { start: startTime, end: Date.now() },
                },
              })
            } else {
              const output = await normalizeCompletedToolOutput(event.result ?? bufferedOutput)
              await Session.updatePart({
                ...part,
                state: {
                  status: "completed",
                  input: part.state.status === "running" ? part.state.input : {},
                  output: output.content,
                  outputBytes: output.bytes,
                  outputTruncated: output.truncated || undefined,
                  title: part.tool,
                  metadata: output.metadata,
                  time: { start: startTime, end: Date.now() },
                },
              })
            }
            toolParts.delete(event.id)
            break
          }

          case "turn_complete": {
            if (event.usage) {
              assistantMessage.tokens = {
                input: event.usage.inputTokens ?? 0,
                output: event.usage.outputTokens ?? 0,
                reasoning: event.usage.reasoningTokens ?? 0,
                cache: { read: 0, write: 0 },
              }
            }
            break
          }

          case "error": {
            log.error("external agent error", { sessionID, message: event.message })
            assistantMessage.error = {
              name: "UnknownError",
              data: { message: event.message },
            }
            break
          }

          case "approval_request": {
            log.info("approval_request received", { id: event.id, tool: event.tool })
            let approved = true
            try {
              approved = await Promise.race([
                approvalDelegate({
                  id: event.id,
                  category: event.category,
                  tool: event.tool,
                  input: event.input,
                }),
                new Promise<boolean>((_, reject) => {
                  if (abort.aborted) return reject(new Error("aborted"))
                  abort.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
                }),
              ])
            } catch (e) {
              log.warn("approval delegate failed or aborted, declining", { error: String(e) })
              approved = false
            }
            log.info("approval_request resolved", { id: event.id, approved })
            if (adapter.respondApproval) {
              await adapter.respondApproval(event.id, approved)
            }
            break
          }
        }
      }
    } catch (e: any) {
      log.error("turn failed", { sessionID, error: String(e) })
      if (!assistantMessage.error) {
        assistantMessage.error = {
          name: "UnknownError",
          data: { message: String(e) },
        }
      }
    }

    await finalizeTextPart(textPart)
    await finalizeReasoningPart(reasoningPart)

    for (const [, part] of toolParts) {
      const startTime = part.state.status === "running" ? part.state.time.start : Date.now()
      await Session.updatePart({
        ...part,
        state: {
          status: "error",
          input: part.state.status === "running" ? part.state.input : {},
          error: "Tool execution interrupted",
          time: { start: startTime, end: Date.now() },
        },
      })
    }

    assistantMessage.finish = assistantMessage.error ? "error" : "stop"
    assistantMessage.time.completed = Date.now()
    await Session.updateMessage(assistantMessage)

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: assistantMessage.id,
      sessionID,
      type: "step-finish",
      reason: assistantMessage.finish,
      tokens: assistantMessage.tokens,
      cost: assistantMessage.cost,
    })

    ExperienceEncoder.onComplete(assistantMessage)
    await Plugin.trigger(
      "session.turn.after",
      {
        sessionID,
        userMessageID: assistantMessage.parentID,
        assistantMessageID: assistantMessage.id,
        assistant: assistantMessage,
        finish: assistantMessage.finish,
        error: assistantMessage.error,
      },
      {},
    )

    const parts = await MessageV2.parts({ sessionID, messageID: assistantMessage.id })
    return { info: assistantMessage, parts }
  }

  async function normalizeCompletedToolOutput(value: string): Promise<{
    content: string
    bytes: number
    truncated: boolean
    metadata: Record<string, any>
  }> {
    const bytes = Buffer.byteLength(value, "utf8")
    const result = await Truncate.output(value, {
      maxBytes: COMPLETED_TOOL_OUTPUT_MAX_BYTES,
      maxLines: 4000,
      direction: "head",
    })
    if (!result.truncated) {
      return {
        content: value,
        bytes,
        truncated: false,
        metadata: { outputBytes: bytes },
      }
    }
    return {
      content: result.content,
      bytes,
      truncated: true,
      metadata: {
        outputBytes: bytes,
        outputMemoryLimitBytes: COMPLETED_TOOL_OUTPUT_MAX_BYTES,
        truncated: true,
        outputPath: result.outputPath,
      },
    }
  }

  async function finalizeTextPart(part: MessageV2.TextPart | undefined) {
    if (!part) return
    part.text = part.text.trimEnd()
    part.time = { start: part.time?.start ?? Date.now(), end: Date.now() }
    await Session.updatePart(part)
  }

  async function finalizeReasoningPart(part: MessageV2.ReasoningPart | undefined) {
    if (!part) return
    part.text = part.text.trimEnd()
    part.time = { ...part.time, end: Date.now() }
    await Session.updatePart(part)
  }
}
