import { ExternalAgent } from "./bridge"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session"
import { Identifier } from "@/id/id"
import { Instance } from "@/scope/instance"
import { Log } from "@/util/log"
import { SessionManager } from "@/session/manager"
import { ExperienceEncoder } from "@/engram/experience-encoder"

export namespace ExternalAgentProcessor {
  const log = Log.create({ service: "external-agent.processor" })

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
      agent,
      mode: agent,
      path: {
        cwd: Instance.directory,
        root: Instance.directory,
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

    SessionManager.setStatus(sessionID, { type: "busy", description: "External agent working..." })

    const toolParts = new Map<string, MessageV2.ToolPart>()
    const toolOutputs = new Map<string, string>()
    let textPart: MessageV2.TextPart | undefined
    let reasoningPart: MessageV2.ReasoningPart | undefined

    try {
      for await (const event of adapter.turn(context, abort)) {
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
            await Session.updatePart({ part: textPart, delta: event.text })
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
            await Session.updatePart({ part: reasoningPart, delta: event.text })
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
                input: tryParseJSON(event.input),
                time: { start: Date.now() },
              },
            })) as MessageV2.ToolPart
            toolParts.set(event.id, part)
            finalizeTextPart(textPart)
            textPart = undefined
            finalizeReasoningPart(reasoningPart)
            reasoningPart = undefined
            break
          }

          case "tool_output": {
            const existing = toolOutputs.get(event.id) ?? ""
            toolOutputs.set(event.id, existing + event.output)
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
              await Session.updatePart({
                ...part,
                state: {
                  status: "completed",
                  input: part.state.status === "running" ? part.state.input : {},
                  output: event.result ?? bufferedOutput,
                  title: part.tool,
                  metadata: {},
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
            let approved = true
            try {
              approved = await approvalDelegate({
                id: event.id,
                tool: event.tool,
                input: event.input,
              })
            } catch (e) {
              log.warn("approval delegate failed, defaulting to approve", { error: String(e) })
            }
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

    finalizeTextPart(textPart)
    finalizeReasoningPart(reasoningPart)

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

    const parts = await MessageV2.parts({ sessionID, messageID: assistantMessage.id })
    return { info: assistantMessage, parts }
  }

  function finalizeTextPart(part: MessageV2.TextPart | undefined) {
    if (!part) return
    part.text = part.text.trimEnd()
    part.time = { start: part.time?.start ?? Date.now(), end: Date.now() }
  }

  function finalizeReasoningPart(part: MessageV2.ReasoningPart | undefined) {
    if (!part) return
    part.text = part.text.trimEnd()
    part.time = { ...part.time, end: Date.now() }
  }

  function tryParseJSON(input?: string): Record<string, any> {
    if (!input) return {}
    try {
      return JSON.parse(input)
    } catch {
      return { raw: input }
    }
  }
}
