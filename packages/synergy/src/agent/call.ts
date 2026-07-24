import type { ModelMessage } from "ai"
import { Agent } from "./agent"
import { Provider } from "../provider/provider"
import { AgentTurn } from "../session/agent-turn"
import type { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"

export namespace AgentCall {
  export type ErrorCode =
    | "agent_not_found"
    | "model_unavailable"
    | "input_too_large"
    | "output_too_large"
    | "timeout"
    | "cancelled"

  export class Error extends globalThis.Error {
    readonly code: ErrorCode

    constructor(code: ErrorCode, message: string, options?: globalThis.ErrorOptions) {
      super(message, options)
      this.name = "AgentCallError"
      this.code = code
    }
  }

  export type TextInput = {
    agent: string
    messages: ModelMessage[]
    user?: MessageV2.User
    sessionId?: string
    fallbackModel?: Provider.Model
    signal?: AbortSignal
    timeoutMs: number
    retries: number
    maxInputChars?: number
    maxOutputChars: number
  }

  function inputCharacters(messages: ModelMessage[]) {
    return messages.reduce((total, message) => {
      if (typeof message.content === "string") return total + message.content.length
      return total + JSON.stringify(message.content).length
    }, 0)
  }

  function interruption(input: { agent: string; signal?: AbortSignal; timeout: AbortController; timeoutMs: number }) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onCancel: (() => void) | undefined
    const promise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        input.timeout.abort(new DOMException("Agent call timed out", "TimeoutError"))
        reject(new Error("timeout", `Agent ${input.agent} timed out after ${input.timeoutMs}ms`))
      }, input.timeoutMs)
      timer.unref?.()
      if (input.signal) {
        onCancel = () => reject(new Error("cancelled", `Agent ${input.agent} was cancelled`))
        if (input.signal.aborted) onCancel()
        else input.signal.addEventListener("abort", onCancel, { once: true })
      }
    })
    return {
      promise,
      dispose() {
        if (timer !== undefined) clearTimeout(timer)
        if (input.signal && onCancel) input.signal.removeEventListener("abort", onCancel)
      },
    }
  }

  export async function text(input: TextInput): Promise<{ text: string }> {
    if (input.signal?.aborted) throw new Error("cancelled", `Agent ${input.agent} was cancelled`)
    if (input.maxInputChars !== undefined && inputCharacters(input.messages) > input.maxInputChars) {
      throw new Error("input_too_large", `Agent ${input.agent} input exceeded ${input.maxInputChars} characters`)
    }

    const agent = await Agent.get(input.agent)
    if (!agent) throw new Error("agent_not_found", `Agent is unavailable: ${input.agent}`)
    const configured = await Agent.getAvailableModel(agent)
    const model = configured
      ? await Provider.getModel(configured.providerID, configured.modelID).catch(() => input.fallbackModel)
      : input.fallbackModel
    if (!model) throw new Error("model_unavailable", `Agent ${input.agent} has no available model`)
    if (input.signal?.aborted) throw new Error("cancelled", `Agent ${input.agent} was cancelled`)

    const sessionID = input.user?.sessionID ?? input.sessionId ?? Identifier.ascending("session")
    const user: MessageV2.User =
      input.user ??
      ({
        id: Identifier.ascending("message"),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: agent.name,
        model: { providerID: model.providerID, modelID: model.id },
      } satisfies MessageV2.User)
    const timeout = new AbortController()
    const output = new AbortController()
    const abort = input.signal
      ? AbortSignal.any([input.signal, timeout.signal, output.signal])
      : AbortSignal.any([timeout.signal, output.signal])
    const interrupted = interruption({
      agent: input.agent,
      signal: input.signal,
      timeout,
      timeoutMs: input.timeoutMs,
    })
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, interrupted.promise])

    try {
      const stream = await wait(
        AgentTurn.stream({
          agent,
          user,
          toolDefinitions: [],
          model,
          small: true,
          messages: input.messages,
          abort,
          sessionID,
          system: [],
          retries: input.retries,
        }),
      )
      try {
        let value = ""
        await wait(
          (async () => {
            for await (const part of stream.fullStream) {
              if (part.type !== "text-delta") continue
              const chunk = part.text
              if (!chunk) continue
              value += chunk
              if (value.length <= input.maxOutputChars) continue
              output.abort(new DOMException("Agent output exceeded its bound", "AbortError"))
              throw new Error(
                "output_too_large",
                `Agent ${input.agent} output exceeded ${input.maxOutputChars} characters`,
              )
            }
          })(),
        )
        return { text: value }
      } finally {
        await stream.dispose()
      }
    } catch (error) {
      if (error instanceof Error) throw error
      if (input.signal?.aborted) throw new Error("cancelled", `Agent ${input.agent} was cancelled`, { cause: error })
      if (timeout.signal.aborted) {
        throw new Error("timeout", `Agent ${input.agent} timed out after ${input.timeoutMs}ms`, { cause: error })
      }
      throw error
    } finally {
      interrupted.dispose()
    }
  }
}
