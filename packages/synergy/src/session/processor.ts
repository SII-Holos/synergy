import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { SessionEvent } from "./event"
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/session/snapshot"
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
import { ObservabilityMetrics } from "@/observability/metrics"
import { ObservabilityToolFailures } from "@/observability/tool-failures"
import { ObservabilitySpans } from "@/observability/spans"
import { ObservabilityContext } from "@/observability/context"
import { SessionMemoryPressure } from "./memory-pressure"
import { SessionMemoryIncident } from "./memory-incident"
import { LLMTurnMemory } from "./llm-memory"
import { SessionBounds } from "./bounds"
import { ContextUsage } from "./context-usage"
import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"
import type { Tool as AITool } from "ai"
import { AgentTurn } from "./agent-turn"
import { ToolScheduler } from "./tool-scheduler"

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
          afterPersist?: () => Promise<void> | void
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

  type ToolCallState = {
    input: Record<string, any>
    title?: string
    metadata?: Record<string, any>
    start?: number
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
  export type ProcessInput = AgentTurn.Input & {
    executionTools: Record<string, AITool>
    executorKinds: Record<string, import("./tool-scheduler").ToolExecutorKind>
    memoryTurn?: LLMTurnMemory.Handle
  }

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

  function streamToolDiagnostic(toolName: string, error: unknown): ToolDiagnostic {
    const rawMessage = error instanceof Error ? error.message : String(error)
    const errorName = error instanceof Error ? error.name : undefined
    const unavailable = /unavailable tool|no such tool|tool .* not found|unknown tool|no.?such.?tool/i.test(
      `${errorName ?? ""} ${rawMessage}`,
    )
    return {
      code: unavailable ? "unknown_tool" : "invalid_arguments",
      toolName,
      message: unavailable
        ? [
            `The model tried to call unavailable tool "${toolName}".`,
            "This tool is not available in the current session, mode, or permission context. Do not retry the same hidden tool.",
            rawMessage,
          ].join("\n")
        : [
            `The "${toolName}" tool call could not be accepted.`,
            "Rewrite the tool input so it satisfies the current schema, or choose another available tool.",
            rawMessage,
          ].join("\n"),
      metadata: {
        source: "ai_sdk_tool_error",
        errorName,
        rawMessage,
      },
    }
  }

  export function streamToolErrorOutcome(part: MessageV2.ToolPart, error: unknown): ToolOutcome {
    const diagnostic = streamToolDiagnostic(part.tool, error)
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
    generation?: number
    toolDisplay?: (toolName: string) => ToolDisplay | undefined
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    const executions = new Map<string, ToolExecutionSlotInternal>()
    const executionCallbacks = new Map<string, Promise<unknown>>()
    const settlementPromises = new Map<string, Promise<void>>()
    const settledToolCalls = new Set<string>()
    const pendingToolCallStates = new Map<string, ToolCallState>()
    const toolCallStateUpdates = new Map<string, Promise<void>>()
    const generatingAccum: Record<string, string> = {}
    const generatingBytes: Record<string, number> = {}
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
        await outcome.result.afterPersist?.()
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
      settledToolCalls.add(part.callID)
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

    function toolSettlementSnapshot(callID?: string, detail = false): Record<string, any> {
      const ids = detail
        ? callID
          ? [callID]
          : [...new Set([...Object.keys(toolcalls), ...executions.keys(), ...settledToolCalls])]
        : []
      const part = callID ? toolcalls[callID] : undefined
      const slot = callID ? executions.get(callID) : undefined
      return {
        activeToolCallCount: Object.keys(toolcalls).length,
        activeExecutionCount: executions.size,
        executionCallbackCount: executionCallbacks.size,
        settledToolCallCount: settledToolCalls.size,
        settlementPromiseCount: settlementPromises.size,
        ...(callID
          ? {
              callID,
              tool: part?.tool,
              partStatus: part?.state.status,
              hasPart: Boolean(part),
              hasSlot: Boolean(slot),
              hasExecutionCallback: executionCallbacks.has(callID),
              slotStatus: slot?.status,
              hasOutcome: Boolean(slot?.outcome),
              hasSettlementPromise: settlementPromises.has(callID),
              settled: settledToolCalls.has(callID),
            }
          : {}),
        ...(detail
          ? {
              calls: ids.map((id) => {
                const part = toolcalls[id]
                const slot = executions.get(id)
                return {
                  callID: id,
                  tool: part?.tool,
                  partStatus: part?.state.status,
                  hasPart: Boolean(part),
                  hasSlot: Boolean(slot),
                  hasExecutionCallback: executionCallbacks.has(id),
                  slotStatus: slot?.status,
                  hasOutcome: Boolean(slot?.outcome),
                  registeredAt: slot?.registeredAt,
                  resolvedAt: slot?.resolvedAt,
                  hasSettlementPromise: settlementPromises.has(id),
                  settled: settledToolCalls.has(id),
                }
              }),
            }
          : {}),
      }
    }

    function shouldIgnoreSettledStreamEvent(callID: string, event: "tool-input-start" | "tool-call", tool: string) {
      if (!settledToolCalls.has(callID)) return false
      delete generatingAccum[callID]
      delete generatingBytes[callID]
      log.warn("ignoring tool stream event after settlement", {
        sessionID: input.sessionID,
        messageID: input.assistantMessage.id,
        callID,
        tool,
        event,
        snapshot: toolSettlementSnapshot(callID),
      })
      return true
    }

    function settleTrackedExecution(toolCallId: string): Promise<void> | undefined {
      const existing = settlementPromises.get(toolCallId)
      if (existing) {
        log.info("tool.execution.settle.reuse", {
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          callID: toolCallId,
          snapshot: toolSettlementSnapshot(toolCallId),
        })
        return existing
      }

      const slot = executions.get(toolCallId)
      const outcome = slot?.outcome
      const part = toolcalls[toolCallId]
      if (!slot || !outcome || !part || part.state.status !== "running") {
        log.info("tool.execution.settle.skip", {
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          callID: toolCallId,
          reason: !slot ? "missing_slot" : !outcome ? "missing_outcome" : !part ? "missing_part" : "part_not_running",
          snapshot: toolSettlementSnapshot(toolCallId),
        })
        return undefined
      }

      log.info("tool.execution.settle.start", {
        sessionID: input.sessionID,
        messageID: input.assistantMessage.id,
        callID: toolCallId,
        tool: part.tool,
        outcomeStatus: outcome.status,
        snapshot: toolSettlementSnapshot(toolCallId),
      })

      const settlement = (async () => {
        await settleToolPart(part, outcome)
        executions.delete(toolCallId)
        delete toolcalls[toolCallId]
        log.info("tool.execution.settle.completed", {
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          callID: toolCallId,
          tool: part.tool,
          snapshot: toolSettlementSnapshot(toolCallId),
        })
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
            snapshot: toolSettlementSnapshot(toolCallId),
          }),
        )
        .finally(() => settlementPromises.delete(toolCallId))
      return settlement
    }

    async function waitForTrackedSettlements() {
      if (settlementPromises.size === 0) return
      log.info("tool.execution.settlement.wait", {
        sessionID: input.sessionID,
        messageID: input.assistantMessage.id,
        snapshot: toolSettlementSnapshot(),
      })
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
      if (!slot) {
        log.warn("tool.execution.wait.missing_slot", {
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          callID: part.callID,
          tool: part.tool,
          snapshot: toolSettlementSnapshot(part.callID),
        })
        return undefined
      }
      if (slot.outcome) {
        log.info("tool.execution.wait.outcome_ready", {
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          callID: part.callID,
          tool: part.tool,
          slotStatus: slot.status,
          outcomeStatus: slot.outcome.status,
        })
        return slot.outcome
      }

      const waitMs = await pendingExecutionWaitMs(part)
      log.info("tool.execution.wait.pending", {
        sessionID: input.sessionID,
        messageID: input.assistantMessage.id,
        callID: part.callID,
        tool: part.tool,
        waitMs,
        snapshot: toolSettlementSnapshot(part.callID),
      })
      const outcome = (await raceWithTimeout(slot.promise, waitMs)) as ToolOutcome | undefined
      log[outcome ? "info" : "warn"]("tool.execution.wait.finished", {
        sessionID: input.sessionID,
        messageID: input.assistantMessage.id,
        callID: part.callID,
        tool: part.tool,
        waitMs,
        outcomeStatus: outcome?.status,
        snapshot: toolSettlementSnapshot(part.callID),
      })
      return outcome
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

    function stageToolCallState(callID: string, state: ToolCallState) {
      const pending = pendingToolCallStates.get(callID)
      pendingToolCallStates.set(callID, {
        input: state.input,
        title: state.title ?? pending?.title,
        metadata: ToolTimeout.mergeMetadata(pending?.metadata, state.metadata),
        start: state.start ?? pending?.start,
      })
    }

    async function flushToolCallState(callID: string) {
      const match = toolcalls[callID]
      if (!match || match.state.status !== "running") return
      const state = pendingToolCallStates.get(callID)
      if (!state) return
      pendingToolCallStates.delete(callID)

      const updated = await Session.updatePart({
        ...match,
        state: {
          ...match.state,
          title: state.title ?? match.state.title,
          metadata: ToolTimeout.mergeMetadata(match.state.metadata, state.metadata) ?? match.state.metadata,
          status: "running",
          input: state.input,
          time: {
            start: state.start ?? match.state.time.start,
          },
        },
      })
      Object.assign(match, updated)
    }

    async function queueToolCallStateFlush(callID: string) {
      const previous = toolCallStateUpdates.get(callID)?.catch(() => {}) ?? Promise.resolve()
      const update = previous.then(() => flushToolCallState(callID))
      toolCallStateUpdates.set(callID, update)
      try {
        await update
      } finally {
        if (toolCallStateUpdates.get(callID) === update) toolCallStateUpdates.delete(callID)
      }
    }

    async function updateToolCallState(callID: string, state: ToolCallState) {
      stageToolCallState(callID, state)
      await queueToolCallStateFlush(callID)
    }

    function forgetToolCall(callID: string) {
      executions.delete(callID)
      pendingToolCallStates.delete(callID)
      toolCallStateUpdates.delete(callID)
      delete toolcalls[callID]
      delete generatingAccum[callID]
      delete generatingBytes[callID]
    }

    async function waitForOutcomesAndSettle(parts: MessageV2.Part[]) {
      await Promise.allSettled(
        parts.map(async (part) => {
          if (part.type !== "tool" || part.state.status === "completed" || part.state.status === "error") return
          if (part.type === "tool" && settledToolCalls.has(part.callID)) return
          const outcome = await waitForPendingExecution(part)
          if (!outcome) return
          await settleTrackedExecution(part.callID)
        }),
      )
    }

    async function resolveUnsettledParts(parts: MessageV2.Part[], fastAbort: boolean) {
      log.info("tool.execution.unsettled.scan", {
        sessionID: input.sessionID,
        messageID: input.assistantMessage.id,
        fastAbort,
        partCount: parts.length,
        snapshot: toolSettlementSnapshot(),
      })
      for (const part of parts) {
        if (part.type !== "tool" || part.state.status === "completed" || part.state.status === "error") continue
        if (settledToolCalls.has(part.callID)) continue
        const slot = executions.get(part.callID)
        if (slot?.outcome) {
          log.info("tool.execution.unsettled.settle_ready", {
            sessionID: input.sessionID,
            messageID: input.assistantMessage.id,
            callID: part.callID,
            tool: part.tool,
            outcomeStatus: slot.outcome.status,
            snapshot: toolSettlementSnapshot(part.callID),
          })
          await settleToolPart(part, slot.outcome)
          forgetToolCall(part.callID)
        } else {
          const reason = slot ? "pending_execution_slot_timeout" : "missing_execution_slot"
          log.warn("tool.execution.unsettled.erroring_part", {
            sessionID: input.sessionID,
            messageID: input.assistantMessage.id,
            callID: part.callID,
            tool: part.tool,
            reason,
            fastAbort,
            snapshot: toolSettlementSnapshot(part.callID),
          })
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
          settledToolCalls.add(part.callID)
          forgetToolCall(part.callID)
        }
      }
    }

    function beginExecution(callID: string): ToolExecutionSlot {
      const existing = executions.get(callID)
      if (existing) {
        log.info("tool.execution.slot.reuse", {
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          callID,
          snapshot: toolSettlementSnapshot(callID),
        })
        return existing
      }

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
            snapshot: toolSettlementSnapshot(callID),
          })
          return
        }
        log.info("tool.execution.slot.resolve", {
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          callID,
          outcomeStatus: outcome.status,
          snapshot: toolSettlementSnapshot(callID),
        })
        underlyingResolve.call(base, outcome)
        const internal = executions.get(callID)
        if (internal) internal.resolvedAt = Date.now()
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
      log.info("tool.execution.slot.created", {
        sessionID: input.sessionID,
        messageID: input.assistantMessage.id,
        callID,
        snapshot: toolSettlementSnapshot(callID),
      })
      void settleTrackedExecution(callID)
      return slot
    }

    function executeOnce<T>(callID: string, execute: () => Promise<T>): Promise<T> {
      const existing = executionCallbacks.get(callID)
      if (existing) {
        log.warn("reusing tool execution callback", {
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          callID,
          snapshot: toolSettlementSnapshot(callID),
        })
        return existing as Promise<T>
      }

      const execution = Promise.resolve().then(execute)
      executionCallbacks.set(callID, execution)
      return execution
    }

    function dispose(reason = "manual") {
      const before = toolSettlementSnapshot(undefined, true)
      for (const callID of Object.keys(toolcalls)) delete toolcalls[callID]
      executions.clear()
      pendingToolCallStates.clear()
      toolCallStateUpdates.clear()
      executionCallbacks.clear()
      settlementPromises.clear()
      settledToolCalls.clear()
      for (const callID of Object.keys(generatingAccum)) delete generatingAccum[callID]
      for (const callID of Object.keys(generatingBytes)) delete generatingBytes[callID]
      snapshot = undefined
      log.info("processor disposed", {
        sessionID: input.sessionID,
        messageID: input.assistantMessage.id,
        reason,
        before,
      })
    }

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      beginExecution,
      updateToolCallState,
      executeOnce,
      dispose,
      async process(streamInput: ProcessInput) {
        log.info("process")
        const turnTraceId = ObservabilityContext.current().traceId ?? Observability.traceId("turn")
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
        try {
          while (true) {
            let streamAborted = false
            try {
              input.abort.throwIfAborted()
              let currentText: MessageV2.TextPart | undefined
              let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
              const deferredToolCalls: Array<{
                callID: string
                toolName: string
                input: Record<string, unknown>
              }> = []
              SessionMemoryPressure.probe("processor.before_llm_stream", {
                sessionID: input.sessionID,
                messageID: input.assistantMessage.id,
              })
              SessionManager.setExecutionPhase(input.sessionID, "queued_agent")
              const {
                executionTools: _executionTools,
                executorKinds: _executorKinds,
                memoryTurn: _memoryTurn,
                ...agentTurnInput
              } = streamInput
              const stream = await AgentTurn.stream(agentTurnInput)
              agentTurnInput.system?.splice(0)
              agentTurnInput.lateSystem?.splice(0)
              agentTurnInput.messages?.splice(0)
              agentTurnInput.toolDefinitions?.splice(0)
              agentTurnInput.activeToolIDs?.splice(0)
              SessionManager.setExecutionPhase(input.sessionID, "running_agent")
              streamInput.memoryTurn?.streamStarted()
              SessionMemoryPressure.probe("processor.after_llm_stream", {
                sessionID: input.sessionID,
                messageID: input.assistantMessage.id,
              })
              const llmSpan = ObservabilitySpans.start({
                name: "llm.request",
                module: "llm",
                sessionID: input.sessionID,
                messageID: input.assistantMessage.id,
                attributes: { provider: input.model.providerID, model: input.model.id },
              })
              const llmStartedAt = Date.now()
              let firstTokenSeen = false
              const streamStats = {
                text: { lastChunkAt: undefined as number | undefined, outputChars: 0, gapTotalMs: 0, gapCount: 0 },
                reasoning: {
                  lastChunkAt: undefined as number | undefined,
                  outputChars: 0,
                  gapTotalMs: 0,
                  gapCount: 0,
                },
              }

              function recordChunkMetrics(kind: "text" | "reasoning", chars: number) {
                const now = Date.now()
                const stats = streamStats[kind]
                if (stats.lastChunkAt !== undefined) {
                  stats.gapTotalMs += now - stats.lastChunkAt
                  stats.gapCount++
                }
                stats.lastChunkAt = now
                stats.outputChars += chars
              }

              function flushChunkMetrics() {
                const elapsedSeconds = Math.max(0.001, (Date.now() - llmStartedAt) / 1000)
                for (const kind of ["text", "reasoning"] as const) {
                  const stats = streamStats[kind]
                  if (stats.gapCount > 0) {
                    ObservabilityMetrics.record({
                      name: "llm.stream.chunk_gap",
                      value: stats.gapTotalMs / stats.gapCount,
                      unit: "ms",
                      module: "llm",
                      sessionID: input.sessionID,
                      messageID: input.assistantMessage.id,
                      labels: { provider: input.model.providerID, model: input.model.id, kind },
                    })
                  }
                  if (stats.outputChars === 0) continue
                  ObservabilityMetrics.record({
                    name: "llm.stream.output_chars_per_second",
                    value: stats.outputChars / elapsedSeconds,
                    unit: "count",
                    module: "llm",
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.id,
                    labels: { provider: input.model.providerID, model: input.model.id, kind },
                  })
                }
              }

              try {
                for await (const value of stream.fullStream) {
                  input.abort.throwIfAborted()
                  switch (value.type) {
                    case "start":
                      SessionManager.setStatus(input.sessionID, { type: "busy" })
                      ObservabilityMetrics.record({
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
                        ObservabilityMetrics.record({
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
                        streamInput.memoryTurn?.addOutputChars(value.text.length)
                        ObservabilityMetrics.record({
                          name: "llm.stream.output_chars",
                          value: value.text.length,
                          unit: "count",
                          module: "llm",
                          sessionID: input.sessionID,
                          messageID: input.assistantMessage.id,
                          labels: { kind: "reasoning" },
                        })
                        recordChunkMetrics("reasoning", value.text.length)
                      }
                      if (value.id in reasoningMap) {
                        const part = reasoningMap[value.id]
                        part.text += value.text
                        if (value.providerMetadata) part.metadata = value.providerMetadata
                        if (part.text) await Session.updatePartDelta(part, value.text)
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
                      if (shouldIgnoreSettledStreamEvent(value.id, "tool-input-start", value.toolName)) break
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
                      generatingBytes[value.id] = 0
                      break
                    }

                    case "tool-input-delta": {
                      const match = toolcalls[value.id]
                      if (!match) break
                      const prevRaw = generatingAccum[value.id]
                      if (prevRaw === undefined) break
                      const receivedBytes = (generatingBytes[value.id] ?? 0) + SessionBounds.byteLength(value.delta)
                      if (receivedBytes > SessionBounds.TOOL_INPUT_MAX_BYTES) {
                        const error = SessionBounds.toolInputExceededMessage()
                        const part = await Session.updatePart({
                          ...match,
                          state: {
                            status: "error",
                            input: {},
                            error,
                            metadata: streamingToolMetadata(match),
                            time: { start: Date.now(), end: Date.now() },
                          },
                        })
                        toolcalls[value.id] = part as MessageV2.ToolPart
                        settledToolCalls.add(value.id)
                        delete generatingAccum[value.id]
                        delete generatingBytes[value.id]
                        throw new Error(error)
                      }
                      generatingBytes[value.id] = receivedBytes
                      const raw = prevRaw + value.delta
                      generatingAccum[value.id] = raw
                      streamInput.memoryTurn?.observeToolRawChars(value.id, raw.length)
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
                      streamInput.memoryTurn?.observeToolRawChars(value.id, raw.length)
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
                      log.info("tool.stream.tool_call.received", {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        callID: value.toolCallId,
                        tool: value.toolName,
                        hadPart: Boolean(toolcalls[value.toolCallId]),
                        hadSlot: executions.has(value.toolCallId),
                        snapshot: toolSettlementSnapshot(value.toolCallId),
                      })
                      if (shouldIgnoreSettledStreamEvent(value.toolCallId, "tool-call", value.toolName)) break
                      const match = toolcalls[value.toolCallId]
                      const pendingState = pendingToolCallStates.get(value.toolCallId)
                      pendingToolCallStates.delete(value.toolCallId)
                      const streamedRaw = generatingAccum[value.toolCallId]
                      const toolInput = SessionToolInput.normalize(value.input)
                      const toolInputBytes = SessionBounds.toolInputByteLength(toolInput)
                      log.info("tool.stream.tool_call.input_ready", {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        callID: value.toolCallId,
                        tool: value.toolName,
                        source: "ai_sdk_input",
                        bytes: toolInputBytes,
                        streamedBytes: streamedRaw === undefined ? undefined : SessionBounds.byteLength(streamedRaw),
                      })
                      const runningMetadata = ToolTimeout.mergeMetadata(
                        runningToolMetadata(value.toolName, value.providerMetadata),
                        pendingState?.metadata,
                      )
                      log.info("tool.stream.tool_call.metadata_ready", {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        callID: value.toolCallId,
                        tool: value.toolName,
                      })
                      streamInput.memoryTurn?.observeToolRawChars(
                        value.toolCallId,
                        streamedRaw !== undefined
                          ? streamedRaw.length
                          : LLMTurnMemory.estimateChars(toolInput, SessionBounds.TOOL_INPUT_MAX_BYTES),
                      )
                      if (toolInputBytes > SessionBounds.TOOL_INPUT_MAX_BYTES) {
                        const error = SessionBounds.toolInputExceededMessage()
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
                            status: "error",
                            input: {},
                            error,
                            metadata: runningMetadata,
                            time: { start: Date.now(), end: Date.now() },
                          },
                          metadata: value.providerMetadata,
                        })
                        toolcalls[value.toolCallId] = part as MessageV2.ToolPart
                        settledToolCalls.add(value.toolCallId)
                        delete generatingAccum[value.toolCallId]
                        delete generatingBytes[value.toolCallId]
                        throw new Error(error)
                      }
                      log.info("tool.stream.tool_call.persist_running", {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        callID: value.toolCallId,
                        tool: value.toolName,
                      })
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
                          title: pendingState?.title,
                          metadata: runningMetadata,
                          time: {
                            start: pendingState?.start ?? Date.now(),
                          },
                        },
                        metadata: value.providerMetadata,
                      })
                      toolcalls[value.toolCallId] = part as MessageV2.ToolPart
                      await queueToolCallStateFlush(value.toolCallId)
                      delete generatingAccum[value.toolCallId]
                      delete generatingBytes[value.toolCallId]
                      log.info("tool.stream.tool_call.part_running", {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        callID: value.toolCallId,
                        tool: value.toolName,
                        hasSlot: executions.has(value.toolCallId),
                        snapshot: toolSettlementSnapshot(value.toolCallId),
                      })

                      deferredToolCalls.push({
                        callID: value.toolCallId,
                        toolName: value.toolName,
                        input: toolInput,
                      })
                      break
                    }
                    case "tool-result": {
                      const slot = executions.get(value.toolCallId)
                      log.info("tool.stream.tool_result.received", {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        callID: value.toolCallId,
                        hadSlot: Boolean(slot),
                        slotStatus: slot?.status,
                        hasOutcome: Boolean(slot?.outcome),
                        snapshot: toolSettlementSnapshot(value.toolCallId),
                      })
                      if (slot?.status === "pending") await raceWithTimeout(slot.promise, TOOL_SETTLE_TIMEOUT)
                      await settleTrackedExecution(value.toolCallId)
                      break
                    }

                    case "tool-error": {
                      log.warn("tool.stream.tool_error.received", {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        callID: value.toolCallId,
                        hadPart: Boolean(toolcalls[value.toolCallId]),
                        hadSlot: executions.has(value.toolCallId),
                        error: value.error instanceof Error ? value.error.message : String(value.error),
                        snapshot: toolSettlementSnapshot(value.toolCallId),
                      })
                      const match = toolcalls[value.toolCallId]
                      const slot = executions.get(value.toolCallId)
                      const rejected =
                        value.error instanceof PermissionNext.RejectedError ||
                        value.error instanceof Question.RejectedError
                      if (!slot && !rejected && !settledToolCalls.has(value.toolCallId)) {
                        const diagnostic = streamToolDiagnostic(value.toolName, value.error)
                        ObservabilityToolFailures.record({
                          tool: value.toolName,
                          sessionID: input.sessionID,
                          messageID: input.assistantMessage.id,
                          callID: value.toolCallId,
                          phase: "llm.tool_call",
                          error: value.error,
                          errorClass: diagnostic.code,
                          owner: "llm",
                        })
                      }
                      if (match && match.state.status === "running") {
                        if (slot?.status === "pending") await raceWithTimeout(slot.promise, TOOL_SETTLE_TIMEOUT)
                        const settlement = settleTrackedExecution(value.toolCallId)
                        if (settlement) {
                          await settlement
                        } else if (!slot) {
                          await settleToolPart(match, streamToolErrorOutcome(match, value.error))
                          delete toolcalls[value.toolCallId]
                        }
                      }
                      if (rejected) blocked = shouldBreak
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
                      ObservabilityMetrics.record({
                        name: "llm.tokens.input",
                        value: usage.tokens.input,
                        unit: "tokens",
                        module: "llm",
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        labels: { provider: input.model.providerID, model: input.model.id },
                      })
                      ObservabilityMetrics.record({
                        name: "llm.tokens.output",
                        value: usage.tokens.output,
                        unit: "tokens",
                        module: "llm",
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        labels: { provider: input.model.providerID, model: input.model.id },
                      })
                      ObservabilityMetrics.record({
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
                      if (hasProviderInputUsage(value.usage) && stream.contextUsageDraft) {
                        input.assistantMessage.contextUsage = ContextUsage.reconcile(
                          stream.contextUsageDraft,
                          ModelLimit.actualInput(usage.tokens),
                        )
                      }
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
                        ObservabilityMetrics.record({
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
                        streamInput.memoryTurn?.addOutputChars(value.text.length)
                        ObservabilityMetrics.record({
                          name: "llm.stream.output_chars",
                          value: value.text.length,
                          unit: "count",
                          module: "llm",
                          sessionID: input.sessionID,
                          messageID: input.assistantMessage.id,
                          labels: { kind: "text" },
                        })
                        recordChunkMetrics("text", value.text.length)
                      }
                      if (currentText) {
                        currentText.text += value.text
                        if (value.providerMetadata) currentText.metadata = value.providerMetadata
                        if (currentText.text) await Session.updatePartDelta(currentText, value.text)
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
                      streamAborted = true
                      break

                    default:
                      log.info("unhandled", {
                        ...value,
                      })
                      continue
                  }
                }
                ObservabilitySpans.end(llmSpan, {
                  attributes: { provider: input.model.providerID, model: input.model.id },
                })
              } catch (error) {
                ObservabilitySpans.end(llmSpan, { status: "error", error })
                throw error
              } finally {
                await stream.dispose()
                streamInput.memoryTurn?.streamDisposed()
                flushChunkMetrics()
                currentText = undefined
                reasoningMap = {}
                SessionMemoryPressure.probe("processor.after_full_stream", {
                  sessionID: input.sessionID,
                  messageID: input.assistantMessage.id,
                })
              }
              if (deferredToolCalls.length > 0) {
                SessionManager.setExecutionPhase(input.sessionID, "authorizing_tools")
              }
              for (const call of deferredToolCalls) {
                if (!shouldAskDoomLoop(Object.values(toolcalls), call.toolName, call.input)) continue
                const agent = await Agent.get(input.assistantMessage.agent)
                const session = await Session.get(input.assistantMessage.sessionID)
                await PermissionNext.ask({
                  permission: "doom_loop",
                  patterns: [call.toolName],
                  sessionID: input.assistantMessage.sessionID,
                  metadata: {
                    tool: call.toolName,
                    input: call.input,
                  },
                  ruleset: PermissionNext.merge(agent.permission, PermissionNext.sessionRuleset(session)),
                  signal: input.abort,
                })
              }
              if (deferredToolCalls.length > 0) {
                SessionManager.setExecutionPhase(input.sessionID, "queued_tools")
              }
              await Promise.all(
                deferredToolCalls.map(async (call) => {
                  if (!streamInput.executionTools) return
                  const task = await ToolScheduler.dispatch({
                    sessionID: input.sessionID,
                    generation: input.generation ?? 0,
                    messageID: input.assistantMessage.id,
                    callID: call.callID,
                    toolName: call.toolName,
                    input: call.input,
                    tool: streamInput.executionTools[call.toolName],
                    executor: streamInput.executorKinds[call.toolName],
                    processor: result,
                    signal: input.abort,
                    onState(state) {
                      if (state === "running") SessionManager.setExecutionPhase(input.sessionID, "running_tools")
                    },
                  })
                  await settleTrackedExecution(call.callID)
                  if (
                    shouldBreak &&
                    (task.errorName === PermissionNext.RejectedError.name ||
                      task.errorName === Question.RejectedError.name)
                  ) {
                    blocked = true
                  }
                }),
              )
              SessionManager.setExecutionPhase(input.sessionID, "waiting_background")
            } catch (e: any) {
              fastAbort = isFastAbort(input.abort, e)
              if (SessionMemoryIncident.isOutOfMemory(e)) {
                await SessionMemoryIncident.capture({
                  error: e,
                  sessionID: input.sessionID,
                  messageID: input.assistantMessage.id,
                }).catch((incidentError) => {
                  log.warn("failed to capture OOM incident", { error: incidentError })
                })
              }
              log.error("process", {
                error: e,
              })
              const error = MessageV2.fromError(e, { providerID: input.model.providerID, modelID: input.model.id })
              const retry = fastAbort ? undefined : SessionRetry.retryable(error)
              if (retry !== undefined && attempt < SessionRetry.RETRY_MAX_ATTEMPTS) {
                attempt++
                const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
                ObservabilityMetrics.record({
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
              ObservabilityMetrics.record({
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
            SessionMemoryPressure.probe("processor.after_tool_settlement", {
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
            })
            // Flush buffered streaming part writes before reading parts to
            // finalize the message. A turn interrupted mid-stream (idle timeout,
            // provider error, abort) never fires the terminal part write that
            // normally flushes, so without this the persisted/finalized parts
            // would be missing the last streamed content (issue #327).
            await Session.flushPartWrites()
            SessionMemoryPressure.probe("processor.after_flush_part_writes", {
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
            })
            let parts = await MessageV2.parts({
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
            })
            if (fastAbort || streamAborted || input.assistantMessage.error) {
              const incompleteStreamingParts = parts.filter(
                (part): part is MessageV2.TextPart | MessageV2.ReasoningPart =>
                  (part.type === "text" || part.type === "reasoning") && !!part.text && !part.time?.end,
              )
              await Promise.all(incompleteStreamingParts.map((part) => Session.updatePart(part)))
            }
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
            SessionMemoryPressure.probe("processor.after_plugin_turn_after", {
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
            })
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
            SessionMemoryPressure.probe("processor.after_observability_turn_end", {
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
            })
            if (blocked) return "stop"
            if (input.assistantMessage.error) return "stop"
            return "continue"
          }
        } finally {
          dispose("process.complete")
        }
      },
    }
    return result
  }
  function hasProviderInputUsage(usage: unknown): boolean {
    if (!usage || typeof usage !== "object") return false
    const inputTokens = (usage as { inputTokens?: unknown }).inputTokens
    return typeof inputTokens === "number" && Number.isFinite(inputTokens)
  }
}
