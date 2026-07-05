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
import { TimeoutConfig } from "@/util/timeout-config"
import { PermissionNext } from "@/permission/next"
import { ExperienceEncoder } from "@/library/experience-encoder"
import { Question } from "@/question"
import { ToolTimeout } from "@/tool/timeout"
import { Observability } from "@/observability"
import { ToolDiagnostic } from "@/tool/diagnostic"
import type { ToolDisplay } from "@ericsanchezok/synergy-plugin/tool"
import { SessionToolInput } from "./tool-input"
import { PerformanceMetrics } from "@/performance/metrics"
import { PerformanceSpans } from "@/performance/spans"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const TOOL_SETTLE_TIMEOUT = 5_000
  const log = Log.create({ service: "session.processor" })

  export type ToolOutcome =
    | {
        status: "completed"
        input: any
        result: {
          output: string
          title: string
          metadata: Record<string, any>
          attachments?: MessageV2.AttachmentPart[]
        }
      }
    | { status: "error"; input: any; error: string; metadata?: Record<string, any> }
  export type ToolExecutionSlot = {
    callID: string
    promise: Promise<ToolOutcome>
    resolve(outcome: ToolOutcome): void
    complete(input: unknown, result: ToolOutcomeCompletedResult): void
    fail(input: unknown, error: string, metadata?: Record<string, any>): void
    readonly outcome: ToolOutcome | undefined
    readonly status: "pending" | "resolved"
  }

  export type ToolOutcomeCompletedResult = Extract<ToolOutcome, { status: "completed" }>["result"]

  type ToolExecutionSlotInternal = Omit<ToolExecutionSlot, "outcome" | "status"> & {
    outcome: ToolOutcome | undefined
    status: "pending" | "resolved"
    registeredAt: number
    resolvedAt?: number
  }

  export function createSlot(callID: string): ToolExecutionSlot {
    let outcome: ToolOutcome | undefined
    let resolved = false
    let resolvePromise!: (value: ToolOutcome) => void
    const promise = new Promise<ToolOutcome>((resolve) => {
      resolvePromise = resolve
    })
    return {
      callID,
      promise,
      resolve(value: ToolOutcome) {
        if (resolved) return
        resolved = true
        outcome = value
        resolvePromise(value)
      },
      complete(input: unknown, result: ToolOutcomeCompletedResult) {
        this.resolve({ status: "completed", input, result })
      },
      fail(input: unknown, error: string, metadata?: Record<string, any>) {
        this.resolve({ status: "error", input, error, metadata })
      },
      get outcome() {
        return outcome
      },
      get status() {
        return resolved ? "resolved" : "pending"
      },
    }
  }

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

  export function isFastAbort(signal: AbortSignal, error?: unknown): boolean {
    if (signal.aborted) return true
    if (!error || typeof error !== "object") return false
    const name = "name" in error ? String((error as { name?: unknown }).name) : ""
    return name === "AbortError"
  }

  export function unresolvedToolError(fastAbort: boolean) {
    return fastAbort ? "Tool execution aborted" : "Tool execution did not return a final result"
  }

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
    toolDisplay?: (toolName: string) => ToolDisplay | undefined
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    const executions = new Map<string, ToolExecutionSlotInternal>()
    const settlementPromises = new Map<string, Promise<void>>()
    const generatingAccum: Record<string, string> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let fastAbort = input.abort.aborted

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

    function providerMetadataObject(metadata: unknown): Record<string, any> | undefined {
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
      return metadata as Record<string, any>
    }

    function runningToolMetadata(toolName: string, providerMetadata: unknown): Record<string, any> | undefined {
      const metadata = providerMetadataObject(providerMetadata)
      const display = input.toolDisplay?.(toolName)
      if (!display) return metadata
      const existingDisplay = metadata?.display as { media?: Record<string, any> } | undefined
      const media =
        existingDisplay?.media || display.media
          ? {
              ...existingDisplay?.media,
              ...display.media,
            }
          : undefined
      return {
        ...metadata,
        display: {
          ...metadata?.display,
          ...display,
          ...(media ? { media } : {}),
        },
      }
    }

    function streamingToolMetadata(part: MessageV2.ToolPart): Record<string, any> | undefined {
      const state = part.state
      return state.status === "pending" || state.status === "generating" || state.status === "running"
        ? (state.metadata as Record<string, any> | undefined)
        : undefined
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
            input: SessionToolInput.normalize(outcome.input),
            output: outcome.result.output,
            metadata: ToolTimeout.mergeMetadata(
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
            input: SessionToolInput.normalize(outcome.input),
            error: outcome.error,
            metadata: ToolTimeout.mergeMetadata(
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

    function settleTrackedExecution(toolCallId: string): Promise<void> | undefined {
      const existing = settlementPromises.get(toolCallId)
      if (existing) return existing

      const slot = executions.get(toolCallId)
      const outcome = slot?.outcome
      const part = toolcalls[toolCallId]
      if (!slot || !outcome || !part || part.state.status !== "running") return undefined

      const settlement = (async () => {
        await settleToolPart(part, outcome)
        executions.delete(toolCallId)
        delete toolcalls[toolCallId]
      })()
      settlementPromises.set(toolCallId, settlement)
      void settlement
        .catch((error) =>
          log.warn("failed to settle tracked tool execution", {
            sessionID: input.sessionID,
            messageID: input.assistantMessage.id,
            callID: toolCallId,
            tool: part.tool,
            error,
          }),
        )
        .finally(() => settlementPromises.delete(toolCallId))
      return settlement
    }

    async function waitForTrackedSettlements() {
      if (settlementPromises.size === 0) return
      await Promise.allSettled([...settlementPromises.values()])
    }

    async function pendingExecutionWaitMs(part: MessageV2.ToolPart): Promise<number> {
      const metadata =
        part.state.status === "pending" || part.state.status === "generating" || part.state.status === "running"
          ? (part.state.metadata as Record<string, any> | undefined)
          : undefined
      const toolTimeout = metadata?.toolTimeout
      const configured = await TimeoutConfig.resolve()
      const toolTimeoutMs =
        toolTimeout && typeof toolTimeout === "object" && typeof toolTimeout.toolTimeoutMs === "number"
          ? toolTimeout.toolTimeoutMs
          : (configured.toolOverrides[part.tool] ?? configured.toolDefaultMs)
      if (!Number.isFinite(toolTimeoutMs) || toolTimeoutMs <= 0) {
        return TOOL_SETTLE_TIMEOUT
      }

      const startTime = toolStartTime(part)
      const remaining = Math.max(0, startTime + toolTimeoutMs - Date.now())
      return Math.max(TOOL_SETTLE_TIMEOUT, remaining + TOOL_SETTLE_TIMEOUT)
    }

    async function raceWithTimeout(promise: Promise<unknown>, ms: number) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
        if (typeof timer === "object" && "unref" in timer) timer.unref()
      })
      try {
        return await Promise.race([promise, timeout])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    async function waitForPendingExecution(part: MessageV2.ToolPart): Promise<ToolOutcome | undefined> {
      const slot = executions.get(part.callID)
      if (!slot) return undefined
      if (slot.outcome) return slot.outcome

      const waitMs = await pendingExecutionWaitMs(part)
      return (await raceWithTimeout(slot.promise, waitMs)) as ToolOutcome | undefined
    }

    function missingExecutionSlotMetadata(part: MessageV2.ToolPart): Record<string, any> {
      return {
        reason: "missing_execution_slot",
        tool: part.tool,
        callID: part.callID,
        messageID: part.messageID,
        sessionID: part.sessionID,
        partStatus: part.state.status,
        streamMetadata: streamingToolMetadata(part),
      }
    }
    function pendingExecutionSlotMetadata(
      part: MessageV2.ToolPart,
      slot: ToolExecutionSlotInternal,
    ): Record<string, any> {
      return {
        reason: "pending_execution_slot_timeout",
        tool: part.tool,
        callID: part.callID,
        messageID: part.messageID,
        sessionID: part.sessionID,
        partStatus: part.state.status,
        slotStatus: slot.status,
        registeredAt: slot.registeredAt,
        resolvedAt: slot.resolvedAt,
        streamMetadata: streamingToolMetadata(part),
      }
    }

    function forgetToolCall(callID: string) {
      executions.delete(callID)
      delete toolcalls[callID]
    }

    async function waitForOutcomesAndSettle(parts: MessageV2.Part[]) {
      await Promise.allSettled(
        parts.map(async (part) => {
          if (part.type !== "tool" || part.state.status === "completed" || part.state.status === "error") return
          const outcome = await waitForPendingExecution(part)
          if (!outcome) return
          await settleTrackedExecution(part.callID)
        }),
      )
    }

    async function resolveUnsettledParts(parts: MessageV2.Part[], fastAbort: boolean) {
      for (const part of parts) {
        if (part.type !== "tool" || part.state.status === "completed" || part.state.status === "error") continue
        const slot = executions.get(part.callID)
        if (slot?.outcome) {
          await settleToolPart(part, slot.outcome)
          forgetToolCall(part.callID)
        } else {
          const startTime = toolStartTime(part)
          await Session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: unresolvedToolError(fastAbort),
              metadata: fastAbort
                ? streamingToolMetadata(part)
                : ToolTimeout.mergeMetadata(
                    streamingToolMetadata(part),
                    slot ? pendingExecutionSlotMetadata(part, slot) : missingExecutionSlotMetadata(part),
                  ),
              time: {
                start: startTime,
                end: Date.now(),
              },
            },
          })
          forgetToolCall(part.callID)
        }
      }
    }

    function beginExecution(callID: string): ToolExecutionSlot {
      const existing = executions.get(callID)
      if (existing) return existing

      const base = createSlot(callID)
      const underlyingResolve = base.resolve
      base.resolve = (outcome: ToolOutcome) => {
        if (base.status === "resolved") {
          log.warn("ignoring duplicate tool execution outcome", {
            sessionID: input.sessionID,
            messageID: input.assistantMessage.id,
            callID,
            status: outcome.status,
            existingStatus: base.outcome?.status,
          })
          return
        }
        underlyingResolve.call(base, outcome)
        void settleTrackedExecution(callID)
      }
      const slot: ToolExecutionSlotInternal = {
        callID: base.callID,
        promise: base.promise,
        resolve: base.resolve,
        complete: base.complete,
        fail: base.fail,
        get outcome() {
          return base.outcome
        },
        get status() {
          return base.status
        },
        registeredAt: Date.now(),
      }
      executions.set(callID, slot)
      void settleTrackedExecution(callID)
      return slot
    }

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      beginExecution,
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
            input.abort.throwIfAborted()
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            const stream = await LLM.stream(streamInput)
            const llmSpan = PerformanceSpans.start({
              name: "llm.request",
              module: "llm",
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
              attributes: { provider: input.model.providerID, model: input.model.id },
            })
            const llmStartedAt = Date.now()
            let firstTokenSeen = false

            try {
              for await (const value of stream.fullStream) {
                input.abort.throwIfAborted()
                switch (value.type) {
                  case "start":
                    SessionManager.setStatus(input.sessionID, { type: "busy" })
                    PerformanceMetrics.record({
                      name: "llm.stream.start",
                      value: Date.now() - llmStartedAt,
                      unit: "ms",
                      module: "llm",
                      sessionID: input.sessionID,
                      messageID: input.assistantMessage.id,
                      labels: { provider: input.model.providerID, model: input.model.id },
                    })
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
                    if (!firstTokenSeen) {
                      firstTokenSeen = true
                      PerformanceMetrics.record({
                        name: "llm.stream.first_token",
                        value: Date.now() - llmStartedAt,
                        unit: "ms",
                        module: "llm",
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        labels: { provider: input.model.providerID, model: input.model.id, kind: "reasoning" },
                      })
                    }
                    if (value.text) {
                      PerformanceMetrics.record({
                        name: "llm.stream.output_chars",
                        value: value.text.length,
                        unit: "count",
                        module: "llm",
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        labels: { kind: "reasoning" },
                      })
                    }
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
                        metadata: runningToolMetadata(
                          value.toolName,
                          "providerMetadata" in value ? value.providerMetadata : undefined,
                        ),
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
                        metadata: streamingToolMetadata(match),
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
                        metadata: streamingToolMetadata(match),
                      },
                    })
                    toolcalls[value.id] = part as MessageV2.ToolPart
                    break
                  }

                  case "tool-call": {
                    const match = toolcalls[value.toolCallId]
                    const display = input.toolDisplay?.(value.toolName)
                    const toolInput = SessionToolInput.normalize(value.input)
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
                        input: toolInput,
                        metadata: runningToolMetadata(value.toolName, value.providerMetadata),
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart
                    delete generatingAccum[value.toolCallId]

                    if (shouldAskDoomLoop(Object.values(toolcalls), value.toolName, toolInput)) {
                      const agent = await Agent.get(input.assistantMessage.agent)
                      const session = await Session.get(input.assistantMessage.sessionID)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: toolInput,
                        },
                        ruleset: PermissionNext.merge(agent.permission, PermissionNext.sessionRuleset(session)),
                        signal: input.abort,
                      })
                    }
                    await settleTrackedExecution(value.toolCallId)
                    break
                  }
                  case "tool-result": {
                    const slot = executions.get(value.toolCallId)
                    if (slot?.status === "pending") await raceWithTimeout(slot.promise, TOOL_SETTLE_TIMEOUT)
                    await settleTrackedExecution(value.toolCallId)
                    break
                  }

                  case "tool-error": {
                    const match = toolcalls[value.toolCallId]
                    if (match && match.state.status === "running") {
                      const slot = executions.get(value.toolCallId)
                      if (slot?.status === "pending") await raceWithTimeout(slot.promise, TOOL_SETTLE_TIMEOUT)
                      const settlement = settleTrackedExecution(value.toolCallId)
                      if (settlement) {
                        await settlement
                      } else if (!slot) {
                        await settleToolPart(match, streamToolErrorOutcome(match, value.error))
                        delete toolcalls[value.toolCallId]
                      }
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

                  case "finish-step": {
                    const usage = Session.getUsage({
                      model: input.model,
                      usage: value.usage,
                      metadata: value.providerMetadata,
                    })
                    PerformanceMetrics.record({
                      name: "llm.tokens.input",
                      value: usage.tokens.input,
                      unit: "tokens",
                      module: "llm",
                      sessionID: input.sessionID,
                      messageID: input.assistantMessage.id,
                      labels: { provider: input.model.providerID, model: input.model.id },
                    })
                    PerformanceMetrics.record({
                      name: "llm.tokens.output",
                      value: usage.tokens.output,
                      unit: "tokens",
                      module: "llm",
                      sessionID: input.sessionID,
                      messageID: input.assistantMessage.id,
                      labels: { provider: input.model.providerID, model: input.model.id },
                    })
                    PerformanceMetrics.record({
                      name: "llm.request.count",
                      value: 1,
                      unit: "count",
                      module: "llm",
                      sessionID: input.sessionID,
                      messageID: input.assistantMessage.id,
                      labels: {
                        provider: input.model.providerID,
                        model: input.model.id,
                        finishReason: value.finishReason,
                      },
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
                  }

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
                    if (!firstTokenSeen) {
                      firstTokenSeen = true
                      PerformanceMetrics.record({
                        name: "llm.stream.first_token",
                        value: Date.now() - llmStartedAt,
                        unit: "ms",
                        module: "llm",
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        labels: { provider: input.model.providerID, model: input.model.id, kind: "text" },
                      })
                    }
                    if (value.text) {
                      PerformanceMetrics.record({
                        name: "llm.stream.output_chars",
                        value: value.text.length,
                        unit: "count",
                        module: "llm",
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        labels: { kind: "text" },
                      })
                    }
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
              PerformanceSpans.end(llmSpan, { attributes: { provider: input.model.providerID, model: input.model.id } })
            } catch (error) {
              PerformanceSpans.end(llmSpan, { status: "error", error })
              throw error
            }
          } catch (e: any) {
            fastAbort = isFastAbort(input.abort, e)
            log.error("process", {
              error: e,
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            const retry = fastAbort ? undefined : SessionRetry.retryable(error)
            if (retry !== undefined && attempt < SessionRetry.RETRY_MAX_ATTEMPTS) {
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              PerformanceMetrics.record({
                name: "session.turn.retry",
                value: 1,
                unit: "count",
                module: "session",
                sessionID: input.sessionID,
                messageID: input.assistantMessage.id,
                labels: { attempt, retry, errorName: error.name },
              })
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
            PerformanceMetrics.record({
              name: "session.turn.error",
              value: 1,
              unit: "count",
              module: "session",
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
              labels: { errorName: error.name },
            })
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
          fastAbort ||= input.abort.aborted
          if (snapshot) {
            if (!fastAbort) {
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
            }
            snapshot = undefined
          }
          await waitForTrackedSettlements()
          let parts = await MessageV2.parts({
            sessionID: input.sessionID,
            messageID: input.assistantMessage.id,
          })
          if (!fastAbort) {
            await waitForOutcomesAndSettle(parts)
            await waitForTrackedSettlements()
            parts = await MessageV2.parts({
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
            })
          }
          await resolveUnsettledParts(parts, fastAbort)
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
              pendingTools: executions.size,
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
