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
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { ObservabilitySpans } from "@/observability/spans"
import type { LLMTurnMemory } from "./llm-memory"
import { SessionRootVariant } from "./root-variant"
import { SessionPluginHooks } from "./plugin-hooks"
import { reasoningStreamGuardMiddleware } from "./reasoning-stream-guard"

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

  export type PreparedTurn = {
    system: string[]
    baseSystemLength: number
    provider: Provider.WorkerPlan
    params: {
      temperature?: number
      topP?: number
      topK?: number
      options: Record<string, any>
    }
    telemetryEnabled?: boolean
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
    maxOutputTokens?: number
    memoryTurn?: LLMTurnMemory.Handle
    prepared?: PreparedTurn
  }

  export type PreparedStreamInput = Omit<StreamInput, "user" | "agent" | "prepared"> & {
    user: Pick<MessageV2.User, "id">
    agent: Pick<Agent.Info, "name">
    prepared: PreparedTurn
  }

  export interface PromptLayoutInput {
    model: Provider.Model
    profileID?: string
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
      mode: PromptCachePolicy.layout(input.model, input.profileID),
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

    if (PromptCachePolicy.layout(input.model, input.profileID) === "system") {
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

  export async function prepare(input: StreamInput): Promise<PreparedTurn> {
    const [{ Config }, { withPreambleSection }, { SystemPrompt }, { TimeoutConfig }] = await Promise.all([
      import("@/config/config"),
      import("@/agent/prompt/preamble"),
      import("./system"),
      import("@/util/timeout-config"),
    ])
    const trigger = SessionPluginHooks.trigger
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
    const systemTimer = l.time("system.assembly")

    let system: string[] = []
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
    const transformed = await trigger(
      "chat.system.transform",
      {
        phase: "final",
        sessionID: input.sessionID,
        agent: input.agent.name,
        model: { providerID: input.model.providerID, modelID: input.model.id },
        messageID: input.user.id,
        small: input.small,
        system: original,
      },
      { system: original },
    )
    const emptiedByTransform = transformed.system.length === 0
    system = emptiedByTransform ? original : transformed.system
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
    systemTimer.stop()

    const optionsTimer = l.time("options.assembly")
    const [provider, cfg, timeout] = await Promise.all([
      Provider.getProvider(input.model.providerID),
      Config.current(),
      TimeoutConfig.resolve(),
    ])
    l.debug("prompt layout", {
      ...promptLayoutMetadata({
        model: input.model,
        profileID: provider?.profileID,
        system,
        lateSystem: input.lateSystem,
        messages: input.messages,
        systemCacheBreakpoint:
          input.systemCacheBreakpoint === undefined ? undefined : baseSystemLength + input.systemCacheBreakpoint,
      }),
    })
    const variant = SessionRootVariant.options({
      variant: input.user.variant,
      model: input.model,
      small: input.small,
    })
    const base = input.small
      ? ProviderTransform.smallOptions(input.model, provider?.profileID)
      : ProviderTransform.options(input.model, input.sessionID, provider?.options, provider?.profileID)
    const options: Record<string, unknown> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    const thinking = options["thinking"]
    const isAnthropicThinking =
      input.model.api.npm === "@ai-sdk/anthropic" &&
      typeof thinking === "object" &&
      thinking !== null &&
      "type" in thinking &&
      thinking.type === "enabled"

    const params = await trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
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
    return {
      system,
      baseSystemLength,
      provider: await Provider.workerPlan(provider, {
        ttfbMs: timeout.providerTtfbMs,
        idleMs: timeout.providerIdleMs,
        wallMs: timeout.providerWallMs,
      }),
      params,
      telemetryEnabled: cfg.experimental?.openTelemetry,
    }
  }

  export function stream(input: StreamInput): Promise<StreamOutput>
  export function stream(input: PreparedStreamInput): Promise<StreamOutput>
  export async function stream(input: StreamInput | PreparedStreamInput): Promise<StreamOutput> {
    if (process.env.SYNERGY_AGENT_WORKER && !input.prepared) {
      throw new Error("Agent worker requires a Control Plane-prepared provider request")
    }
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
    const prepared = input.prepared ?? (await prepare(input as StreamInput))
    if (process.env.SYNERGY_AGENT_WORKER === "1") {
      await Provider.configureWorkerProvider(input.model, prepared.provider)
    }
    const language = await Provider.getLanguage(input.model)
    langTimer.stop()
    const { system, baseSystemLength, params } = prepared
    l.debug("prompt layout", {
      ...promptLayoutMetadata({
        model: input.model,
        profileID: prepared.provider.profileID,
        system,
        lateSystem: input.lateSystem,
        messages: input.messages,
        systemCacheBreakpoint:
          input.systemCacheBreakpoint === undefined ? undefined : baseSystemLength + input.systemCacheBreakpoint,
      }),
    })
    l.info("params", {
      params,
    })

    const providerMaxOutputTokens = ProviderTransform.maxOutputTokens(
      input.model.api.npm,
      params.options,
      input.model.limit.output,
      OUTPUT_TOKEN_MAX,
      input.model.limit.context,
    )
    const maxOutputTokens = Math.min(providerMaxOutputTokens, input.maxOutputTokens ?? providerMaxOutputTokens)

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
          profileID: prepared.provider.profileID,
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
                    profileID: prepared.provider.profileID,
                    mergeSystemMessages: prepared.provider.options?.mergeSystemMessages === true,
                  })
                }
                return args.params
              },
            },
            // This must wrap extractReasoningMiddleware so malformed empty
            // reasoning blocks are repaired before streamText consumes them.
            reasoningStreamGuardMiddleware(),
            extractReasoningMiddleware({ tagName: "think", startWithReasoning: false }),
          ],
        }),
        experimental_telemetry: { isEnabled: prepared.telemetryEnabled },
      })
      streamTextTimer.stop()
      ObservabilitySpans.end(llmSpan, { attributes: { provider: input.model.providerID, model: input.model.id } })
      return result as StreamOutput
    } catch (error) {
      streamTextTimer.stop()
      ObservabilitySpans.end(llmSpan, { status: "error", error })
      throw error
    }
  }
}
