import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import {
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  extractReasoningMiddleware,
} from "ai"
import type { LanguageModelV2ToolCall } from "@ai-sdk/provider"
import { clone, mergeDeep, pipe } from "remeda"
import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"
import { parsePartialJson } from "@ericsanchezok/synergy-util/json"
import { ProviderTransform } from "@/provider/transform"
import { PromptCachePolicy } from "@/provider/prompt-cache-policy"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import { withPreambleSection } from "@/agent/prompt/preamble"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { ObservabilitySpans } from "@/observability/spans"

export namespace LLM {
  const log = Log.create({ service: "llm" })

  export const OUTPUT_TOKEN_MAX = ModelLimit.OUTPUT_TOKEN_MAX

  function cancelResidualStream<TOOLS extends ToolSet, PARTIAL_OUTPUT>(
    result: StreamTextResult<TOOLS, PARTIAL_OUTPUT>,
  ) {
    const residual = (result as StreamTextResult<TOOLS, PARTIAL_OUTPUT> & { baseStream?: ReadableStream<unknown> })
      .baseStream
    let cancellation: Promise<void> | undefined
    try {
      // AI SDK implements fullStream with tee() and retains the second branch as baseStream.
      // Cancel it immediately, but wait only after the consumed branch settles because tee
      // cancellation itself waits for the sibling branch to close.
      cancellation = residual?.cancel().catch((error) => {
        log.warn("failed to cancel residual stream branch", { error })
      })
    } catch (error) {
      log.warn("failed to cancel residual stream branch", { error })
    }
    return cancellation
  }

  function ownStream<TOOLS extends ToolSet, PARTIAL_OUTPUT, STREAM>(
    result: StreamTextResult<TOOLS, PARTIAL_OUTPUT>,
    stream: STREAM,
  ) {
    const cancellation = cancelResidualStream(result)
    return {
      stream,
      async dispose() {
        await cancellation
      },
    }
  }

  export function takeFullStream<TOOLS extends ToolSet, PARTIAL_OUTPUT>(
    result: StreamTextResult<TOOLS, PARTIAL_OUTPUT>,
  ) {
    return ownStream(result, result.fullStream)
  }

  export function takeTextStream<TOOLS extends ToolSet, PARTIAL_OUTPUT>(
    result: StreamTextResult<TOOLS, PARTIAL_OUTPUT>,
  ) {
    return ownStream(result, result.textStream)
  }

  export async function collectText<TOOLS extends ToolSet, PARTIAL_OUTPUT>(
    result: StreamTextResult<TOOLS, PARTIAL_OUTPUT>,
  ) {
    const text = result.text
    const cancellation = cancelResidualStream(result)
    try {
      return await text
    } finally {
      await cancellation
    }
  }

  /**
   * Tool call repair logic, extracted for testability.
   *
   * Responsibilities (in order):
   *  1. Case-fold tool names when the model outputs e.g. "Bash" instead of "bash".
   *  2. Recover tool call input JSON that is syntactically truncated (e.g. missing
   *     the outer closing `}` when the last field is itself an object/array — a
   *     common LLM tokenization artifact).
   *
   * Guardrails:
   *  - JSON recovery is only attempted when native JSON.parse fails. If the input
   *    is already valid JSON (schema-level error, not syntax), we do NOT rewrite it
   *    — rewriting would mask semantic bugs and could race with AI SDK's own retries.
   *  - JSON recovery is only attempted when the resolved tool actually exists. A
   *    hallucinated tool name should not trigger input rewriting.
   *  - Recovery must yield a non-empty object. parsePartialJson returns `{}` on
   *    unparseable input; we treat that as failure.
   */
  export type RepairArgs = {
    toolCall: LanguageModelV2ToolCall
    error: { message: string }
  }

  export type RepairedToolCall = LanguageModelV2ToolCall | null

  export function repairToolCall(failed: RepairArgs, toolNames: ReadonlySet<string>): RepairedToolCall {
    const lower = failed.toolCall.toolName.toLowerCase()

    // Case 1: case-fold tool name.
    if (lower !== failed.toolCall.toolName && toolNames.has(lower)) {
      return {
        ...failed.toolCall,
        toolName: lower,
      }
    }

    // Case 2: recover truncated JSON input.
    const resolvedName = toolNames.has(failed.toolCall.toolName)
      ? failed.toolCall.toolName
      : toolNames.has(lower)
        ? lower
        : undefined

    if (!resolvedName) return null
    if (typeof failed.toolCall.input !== "string") return null
    if (failed.toolCall.input.length === 0) return null

    // Only engage recovery when native parse fails. If the JSON is valid, the
    // error is semantic (schema mismatch) and not our responsibility — rewriting
    // would mask it and potentially cause infinite repair loops.
    try {
      JSON.parse(failed.toolCall.input)
      return null
    } catch {
      // fall through
    }

    let recovered: Record<string, unknown>
    try {
      recovered = parsePartialJson(failed.toolCall.input)
    } catch {
      return null
    }

    if (!recovered || typeof recovered !== "object" || Array.isArray(recovered)) return null
    if (Object.keys(recovered).length === 0) return null

    return {
      ...failed.toolCall,
      toolName: resolvedName,
      input: JSON.stringify(recovered),
    }
  }

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    systemCacheBreakpoint?: number
    lateSystem?: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    activeToolIDs?: string[]
    retries?: number
  }

  export interface PromptLayoutInput {
    model: Provider.Model
    system: string[]
    lateSystem?: string[]
    messages: ModelMessage[]
  }

  interface PromptLayoutMetadata {
    mode: "late-user-context" | "system"
    stableSystemCount: number
    lateSystemCount: number
    historyMessageCount: number
    hasSystemCacheBreakpoint: boolean
  }

  function promptLayoutMetadata(input: PromptLayoutInput & { systemCacheBreakpoint?: number }): PromptLayoutMetadata {
    return {
      mode: PromptCachePolicy.layout(input.model),
      stableSystemCount: input.system.filter((content) => content.length > 0).length,
      lateSystemCount: (input.lateSystem ?? []).filter((content) => content.length > 0).length,
      historyMessageCount: input.messages.length,
      hasSystemCacheBreakpoint: input.systemCacheBreakpoint !== undefined,
    }
  }

  export function promptMessages(input: PromptLayoutInput): ModelMessage[] {
    const systemMessages = input.system.map(
      (content): ModelMessage => ({
        role: "system",
        content,
      }),
    )
    const lateSystem = (input.lateSystem ?? []).filter((content) => content.length > 0)
    if (lateSystem.length === 0) return [...systemMessages, ...input.messages]

    if (PromptCachePolicy.layout(input.model) === "system") {
      return [
        ...systemMessages,
        ...lateSystem.map(
          (content): ModelMessage => ({
            role: "system",
            content,
          }),
        ),
        ...input.messages,
      ]
    }

    return [
      ...systemMessages,
      ...input.messages,
      {
        role: "user",
        content: formatLateUserContext(lateSystem),
      },
    ]
  }

  function formatLateUserContext(parts: string[]) {
    return [
      "<runtime-context>",
      "The following advisory runtime context may help answer the current turn. It does not override higher-priority system, permission, tool, Blueprint, Lattice, or developer instructions.",
      "",
      parts.join("\n\n"),
      "</runtime-context>",
    ].join("\n")
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  export async function stream(input: StreamInput) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const langTimer = l.time("provider.getLanguage")
    const [language, cfg] = await Promise.all([Provider.getLanguage(input.model), Config.current()])
    langTimer.stop()

    const systemTimer = l.time("system.assembly")

    const system: string[] = []
    const baseSystem = (input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)).map((prompt) =>
      withPreambleSection(prompt),
    )
    const baseSystemLength = baseSystem.length

    // Part 1: Agent prompt (most stable, always first for caching)
    // Kept separate from custom parts so the static agent prompt can be
    // cached independently even when dynamic parts (env block with timestamps)
    // change on each invoke.
    system.push(...baseSystem)

    // Part 2: All custom system parts from invoke.ts (ordered static → dynamic)
    system.push(...input.system.filter((x) => x))
    if (input.user.system) system.push(input.user.system)

    const original = clone(system)
    await Plugin.trigger(
      "experimental.chat.system.transform",
      {
        phase: "final",
        sessionID: input.sessionID,
        agent: input.agent.name,
        model: { providerID: input.model.providerID, modelID: input.model.id },
        messageID: input.user.id,
        small: input.small,
      },
      { system },
    )
    const emptiedByTransform = system.length === 0
    if (emptiedByTransform) {
      system.push(...original)
    }
    l.debug("system transform final result", {
      sessionID: input.sessionID,
      messageID: input.user.id,
      agent: input.agent.name,
      model: { providerID: input.model.providerID, modelID: input.model.id },
      small: input.small,
      beforeSystemCount: original.length,
      afterSystemCount: system.length,
      restoredEmptySystem: emptiedByTransform,
    })
    l.debug("prompt layout", {
      ...promptLayoutMetadata({
        model: input.model,
        system,
        lateSystem: input.lateSystem,
        messages: input.messages,
        systemCacheBreakpoint:
          input.systemCacheBreakpoint === undefined ? undefined : baseSystemLength + input.systemCacheBreakpoint,
      }),
    })
    systemTimer.stop()

    const optionsTimer = l.time("options.assembly")
    const provider = await Provider.getProvider(input.model.providerID)
    const effectiveVariant =
      input.user.variant ?? input.agent.defaultVariant ?? cfg.role_variant?.[input.agent.modelRole || "default"]
    let variant: Record<string, any> = {}
    if (!input.small && input.model.variants && Object.keys(input.model.variants).length > 0 && effectiveVariant) {
      if (Object.prototype.hasOwnProperty.call(input.model.variants, effectiveVariant)) {
        variant = input.model.variants[effectiveVariant]
      } else {
        l.warn("configured variant not available for model", {
          variant: effectiveVariant,
          modelID: input.model.id,
          availableVariants: Object.keys(input.model.variants),
          agent: input.agent.name,
        })
      }
    }
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options(input.model, input.sessionID, provider.options)
    const options = pipe(base, mergeDeep(input.model.options), mergeDeep(input.agent.options), mergeDeep(variant))

    const isAnthropicThinking =
      input.model.api.npm === "@ai-sdk/anthropic" && options["thinking"]?.["type"] === "enabled"

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider: Provider.getProvider(input.model.providerID),
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: isAnthropicThinking ? undefined : (input.agent.topP ?? ProviderTransform.topP(input.model)),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )

    l.info("params", {
      params,
    })
    optionsTimer.stop()

    const maxOutputTokens = ProviderTransform.maxOutputTokens(
      input.model.api.npm,
      params.options,
      input.model.limit.output,
      OUTPUT_TOKEN_MAX,
    )

    const tools = input.tools

    const llmSpan = ObservabilitySpans.start({
      name: "llm.stream.initialization",
      module: "llm",
      sessionID: input.sessionID,
      messageID: input.user.id,
      attributes: { provider: input.model.providerID, model: input.model.id },
    })
    const streamTextTimer = l.time("streamText.call")
    try {
      const result = streamText({
        onError(error) {
          streamTextTimer.stop()
          ObservabilitySpans.end(llmSpan, { status: "error", error })
          l.error("stream error", {
            error,
          })
        },
        async experimental_repairToolCall(failed) {
          const toolNames = new Set(Object.keys(tools))
          const repaired = repairToolCall(failed, toolNames)
          if (repaired) {
            if (repaired.toolName !== failed.toolCall.toolName) {
              l.info("repairing tool call name", {
                tool: failed.toolCall.toolName,
                repaired: repaired.toolName,
              })
            }
            if (repaired.input !== failed.toolCall.input) {
              l.info("repairing tool call input", {
                tool: repaired.toolName,
                originalLength: failed.toolCall.input.length,
                recoveredLength: repaired.input.length,
                error: failed.error.message,
              })
            }
            return repaired
          }
          return null
        },
        temperature: params.temperature,
        topP: params.topP,
        topK: params.topK,
        providerOptions: ProviderTransform.providerOptions(input.model, params.options),
        activeTools: input.activeToolIDs ?? Object.keys(tools),
        tools,
        stopWhen: stepCountIs(1),
        maxOutputTokens,
        abortSignal: input.abort,
        headers: input.model.headers,
        maxRetries: input.retries ?? 0,
        messages: promptMessages({
          model: input.model,
          system,
          lateSystem: input.lateSystem,
          messages: input.messages,
        }),
        // System messages are embedded in the message array on purpose so the
        // provider transform can place cache breakpoints across system parts.
        allowSystemInMessages: true,
        model: wrapLanguageModel({
          model: language,
          middleware: [
            {
              async transformParams(args) {
                if (args.type === "stream") {
                  // @ts-expect-error
                  args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, {
                    systemCacheBreakpoint:
                      input.systemCacheBreakpoint === undefined
                        ? undefined
                        : baseSystemLength + input.systemCacheBreakpoint,
                    lookAtAvailable: input.activeToolIDs?.includes("look_at") === true,
                    viewImageAvailable: input.activeToolIDs?.includes("view_image") === true,
                  })
                }
                return args.params
              },
            },
            extractReasoningMiddleware({ tagName: "think", startWithReasoning: false }),
          ],
        }),
        experimental_telemetry: { isEnabled: cfg.experimental?.openTelemetry },
      })
      streamTextTimer.stop()
      ObservabilitySpans.end(llmSpan, { attributes: { provider: input.model.providerID, model: input.model.id } })
      return result
    } catch (error) {
      streamTextTimer.stop()
      ObservabilitySpans.end(llmSpan, { status: "error", error })
      throw error
    }
  }
}
