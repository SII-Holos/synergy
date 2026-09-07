import { Experiment } from "@/config/experiment"
import { RolloutLedger } from "../session/rollout/ledger"
import type { ModelMessage } from "ai"
import { Agent } from "./agent"
import { Provider } from "../provider/provider"
import { AgentTurn } from "../session/agent-turn"
import { MessageV2 } from "../session/message-v2"
import { RolloutContext } from "../session/rollout/context"
import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { RolloutRecordingError } from "../session/rollout/error"

export namespace AgentCall {
  export type ErrorCode =
    | "agent_not_found"
    | "model_unavailable"
    | "input_too_large"
    | "output_too_large"
    | "timeout"
    | "cancelled"
    | "invalid_owner"

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
    userMetadata?: Record<string, string>
    model?: Provider.Model
    fallbackModel?: Provider.Model
    modelRole?: Provider.ModelRole
    signal?: AbortSignal
    timeoutMs: number
    retries: number
    maxInputChars?: number
    maxOutputChars: number
    small?: boolean
    maxOutputTokens?: number
  }

  export type TextOutput = {
    text: string
    model: Provider.Model
    usage?: Awaited<AgentTurn.Stream["usage"]>
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

  export async function text(input: TextInput): Promise<TextOutput> {
    if (!Experiment.current()) return Experiment.provide(await Experiment.resolve(), () => text(input))
    const causal = RolloutContext.current()
    if (
      !input.user &&
      causal?.owner.kind === "session" &&
      (!input.sessionId || input.sessionId === causal.owner.sessionID)
    ) {
      const [root] = MessageV2.deriveSemantics([
        await MessageV2.get({ sessionID: causal.owner.sessionID, messageID: causal.runID }),
      ])
      if (root.info.role !== "user" || !root.info.isRoot)
        throw new Error("invalid_owner", "Causal agent calls require a persisted root user")
      input = { ...input, user: { ...root.info, system: undefined, variant: undefined } }
    }
    if (causal?.signal)
      input = { ...input, signal: AbortSignal.any([causal.signal, ...(input.signal ? [input.signal] : [])]) }
    if (input.sessionId && (!input.user || input.user.sessionID !== input.sessionId))
      throw new Error("invalid_owner", "Session agent calls require the triggering root user from that session")
    if (input.signal?.aborted) throw new Error("cancelled", `Agent ${input.agent} was cancelled`)
    if (input.maxInputChars !== undefined && inputCharacters(input.messages) > input.maxInputChars) {
      throw new Error("input_too_large", `Agent ${input.agent} input exceeded ${input.maxInputChars} characters`)
    }

    const agent = await Agent.get(input.agent)
    if (!agent) throw new Error("agent_not_found", `Agent is unavailable: ${input.agent}`)
    const model =
      input.model ??
      (await (async () => {
        const configured = input.modelRole
          ? await Provider.resolveRoleModel(input.modelRole)
          : await Agent.getAvailableModel(agent)
        if (!configured) return input.fallbackModel
        return await Provider.getModel(configured.providerID, configured.modelID).catch(() => input.fallbackModel)
      })())
    if (!model) throw new Error("model_unavailable", `Agent ${input.agent} has no available model`)
    if (input.signal?.aborted) throw new Error("cancelled", `Agent ${input.agent} was cancelled`)

    const owningSessionID = input.user?.sessionID ?? input.sessionId
    const inheritedOperation = !owningSessionID && causal?.owner.kind === "operation" ? causal : undefined
    const operationID = owningSessionID
      ? undefined
      : inheritedOperation?.owner.kind === "operation"
        ? inheritedOperation.owner.operationID
        : crypto.randomUUID()
    const sessionID = owningSessionID ?? operationID!
    const owner = owningSessionID
      ? {
          kind: "session" as const,
          sessionID: owningSessionID,
          scopeID: (
            await Storage.read<{ scopeID: string }>(StoragePath.sessionIndex(Identifier.asSessionID(owningSessionID)))
          ).scopeID,
        }
      : (inheritedOperation?.owner ?? {
          kind: "operation" as const,
          operationID: operationID!,
          scopeID: ScopeContext.tryScope()?.id ?? "home",
        })
    const user: MessageV2.User =
      input.user ??
      ({
        id: Identifier.ascending("message"),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: agent.name,
        model: { providerID: model.providerID, modelID: model.id },
        metadata: input.userMetadata,
      } satisfies MessageV2.User)
    const runID = input.user?.rootID ?? input.user?.id ?? inheritedOperation?.runID ?? operationID ?? user.id
    if (owner.kind === "operation") {
      await RolloutLedger.beginRun(owner, runID)
      await RolloutLedger.configureRun(owner, runID, await Experiment.resolve())
    }
    let status: "completed" | "failed" | "cancelled" = "failed"
    let failure: unknown
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
      const starting = AgentTurn.stream({
        agent,
        user,
        toolDefinitions: [],
        model,
        small: input.small ?? true,
        messages: input.messages,
        abort,
        sessionID,
        system: [],
        retries: input.retries,
        recording: {
          owner,
          runID,
          purpose: input.agent,
        },
        maxOutputTokens: input.maxOutputTokens,
      })
      let stream: AgentTurn.Stream
      try {
        stream = await wait(starting)
      } catch (error) {
        await starting.then(
          (late) => late.dispose(),
          (failure: unknown) => {
            if (RolloutRecordingError.isInstance(failure)) throw failure
          },
        )
        throw error
      }
      try {
        let value = ""
        const iterator = stream.fullStream[Symbol.asyncIterator]()
        while (true) {
          const next = await wait(iterator.next())
          if (next.done) break
          const part = next.value
          if (part.type !== "text-delta" || !part.text) continue
          value += part.text
          if (value.length <= input.maxOutputChars) continue
          output.abort(new DOMException("Agent output exceeded its bound", "AbortError"))
          throw new Error("output_too_large", `Agent ${input.agent} output exceeded ${input.maxOutputChars} characters`)
        }
        const usage = await wait(stream.usage)
        status = "completed"
        return { text: value, model, usage }
      } finally {
        await stream.dispose()
      }
    } catch (error) {
      failure = error
      status = input.signal?.aborted || timeout.signal.aborted ? "cancelled" : "failed"
      if (RolloutRecordingError.isInstance(error)) throw error
      if (error instanceof Error) throw error
      if (input.signal?.aborted) throw new Error("cancelled", `Agent ${input.agent} was cancelled`, { cause: error })
      if (timeout.signal.aborted) {
        throw new Error("timeout", `Agent ${input.agent} timed out after ${input.timeoutMs}ms`, { cause: error })
      }
      throw error
    } finally {
      interrupted.dispose()
      if (owner.kind === "operation" && !inheritedOperation) {
        try {
          await RolloutLedger.finishRun(owner, runID, status)
        } catch (error) {
          if (RolloutRecordingError.isInstance(failure)) throw failure
          throw error
        }
      }
    }
  }
}
