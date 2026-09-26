import { RuntimeContext } from "../lifecycle/context"
import { RolloutTool } from "./rollout/tool"
import Ajv2020 from "ajv/dist/2020"
import { Global } from "../global"
import { type Tool as AITool, tool, jsonSchema, type ToolCallOptions, type JSONSchema7 } from "ai"
import z from "zod"
import { Agent } from "../agent/agent"
import { Identifier } from "../id/id"
import { ToolMcpSource } from "../tool/mcp-source"
import { PermissionNext } from "../permission/next"
import { PermissionRules } from "../permission/rules"
import { SmartAllow } from "../permission/smart-allow"
import { ProviderTransform } from "../provider/transform"
import { Provider } from "../provider/provider"
import { Tool } from "../tool/tool"
import { ToolRegistry } from "../tool/registry"
import { ToolTimeout } from "../tool/timeout"
import { ToolExposure } from "../tool/exposure"
import type { ToolDisplay } from "@ericsanchezok/synergy-util/tool"
import { Log } from "../util/log"
import { TimeoutConfig } from "../util/timeout-config"
import { Session } from "."
import { SessionManager } from "./manager"
import type { Info } from "./types"
import { MessageV2 } from "./message-v2"
import type { SessionProcessor } from "./processor"
import { SessionBounds } from "./bounds"
import { SessionToolInput } from "./tool-input"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { EnforcementGate, type Capability, type GateOptions, type SandboxContainment } from "../enforcement/gate"
import { SandboxHost } from "../sandbox/host"
import { approvablePath, formatExplanationForModel } from "../sandbox/explain"
import { SandboxSessionApproval } from "../sandbox/session-approval"
import type { BashSandboxPrepare } from "../tool/bash-contract"
import type { ResolvedProfile } from "../control-profile/types"
import { EnforcementError } from "../enforcement/errors"
import { Config } from "../config/config"
import { ControlProfileCompiler } from "../control-profile/compiler"
import { ApprovalPolicy, type ApprovalMetadata } from "../control-profile/approval"
import { Observability } from "../observability"
import { SessionModePolicy } from "./tool-mode-policy"
import { ToolDiagnostic, ToolDiagnosticError, type ToolDiagnostic as ToolDiagnosticInfo } from "../tool/diagnostic"
import { ObservabilityIssues } from "../observability/issues"
import { ObservabilityToolFailures } from "../observability/tool-failures"
import { ObservabilityMetrics } from "../observability/metrics"
import { ObservabilityRedaction } from "../observability/redaction"
import { ObservabilitySpans } from "../observability/spans"
import { SkillSourceProfile } from "../instruction/source-profile"
import { SessionToolContext } from "./tool-context"
import type { ToolCatalog } from "./tool-catalog"
import { ToolExecutor } from "./tool-executor"
import type { ToolExecutorKind } from "./tool-scheduler"
import { SecretMask } from "../secrets/mask"
import { SecretResolve } from "../secrets/resolve"

export namespace ToolResolver {
  const log = Log.create({ service: "tool.resolver" })
  const neverAbort = new AbortController().signal
  const DEFAULT_STALLED_TOOL_MS = 30_000
  const TOOL_HEARTBEAT_MS = 15_000

  interface ActiveTraceEntry {
    traceId: string
    startedAt: number
    lastActivity: number
    lastHeartbeat: number
    stalled: boolean
    stalledMs: number
    phase: string
    span: ObservabilitySpans.SpanContext | undefined
    sessionID: string
    messageID: string
    callID: string | undefined
    toolName: string
    cwd?: string
    scopeID: string
  }

  const runtimeState = RuntimeContext.state(() => ({
    activeTraces: new Map<string, ActiveTraceEntry>(),
    sweepTimer: null as ReturnType<typeof setInterval> | null,
  }))
  const SWEEP_INTERVAL_MS = 5_000

  function ensureSweepTimer() {
    const instanceState = runtimeState()

    if (instanceState.sweepTimer) return
    instanceState.sweepTimer = setInterval(() => sweepActiveTraces(), SWEEP_INTERVAL_MS)
    if (typeof instanceState.sweepTimer === "object" && "unref" in instanceState.sweepTimer)
      instanceState.sweepTimer.unref()
  }

  export function sweepActiveTraces(now = Date.now()) {
    const instanceState = runtimeState()

    if (instanceState.activeTraces.size === 0) {
      stopSweepTimer()
      return
    }
    for (const entry of instanceState.activeTraces.values()) {
      const traceId = entry.traceId
      const idleMs = now - entry.lastActivity

      if (now - entry.lastHeartbeat >= TOOL_HEARTBEAT_MS) {
        entry.lastHeartbeat = now
        ObservabilitySpans.heartbeat(entry.span, { phase: entry.phase })
        void Observability.emit("tool.heartbeat", {
          traceId,
          spanId: entry.span?.spanId,
          parentSpanId: entry.span?.parentSpanId,
          sessionID: entry.sessionID,
          messageID: entry.messageID,
          callID: entry.callID,
          tool: entry.toolName,
          cwd: entry.cwd,
          scopeID: entry.scopeID,
          data: {
            phase: entry.phase,
            elapsedMs: now - entry.startedAt,
            idleMs,
          },
        }).catch(() => {})
      }

      if (!entry.stalled && idleMs >= entry.stalledMs) {
        entry.stalled = true
        ObservabilitySpans.markStalled(entry.span, { phase: entry.phase, idleMs })
        void Observability.emit("tool.stalled", {
          traceId,
          spanId: entry.span?.spanId,
          parentSpanId: entry.span?.parentSpanId,
          sessionID: entry.sessionID,
          messageID: entry.messageID,
          callID: entry.callID,
          tool: entry.toolName,
          cwd: entry.cwd,
          scopeID: entry.scopeID,
          level: "warn",
          data: {
            phase: entry.phase,
            elapsedMs: now - entry.startedAt,
            idleMs,
            thresholdMs: entry.stalledMs,
          },
        }).catch(() => {})
        ObservabilityMetrics.record({
          name: "tool.execution.stalled",
          value: 1,
          unit: "count",
          module: "tool",
          traceId,
          spanId: entry.span?.spanId,
          sessionID: entry.sessionID,
          messageID: entry.messageID,
          callID: entry.callID,
          tool: entry.toolName,
          labels: { phase: entry.phase },
        })
        ObservabilityIssues.raise({
          code: "PERF_TOOL_STALLED",
          severity: "warning",
          module: "tool",
          title: "Tool execution stalled",
          message: `${entry.toolName} has not reported activity for ${idleMs}ms`,
          recommendation: "Inspect the tool trace and owning tool implementation.",
          traceId,
          spanId: entry.span?.spanId,
          sessionID: entry.sessionID,
          messageID: entry.messageID,
          callID: entry.callID,
          scopeID: entry.scopeID,
          evidence: { idleMs, thresholdMs: entry.stalledMs, tool: entry.toolName },
        })
      }
    }
  }

  function stopSweepTimer() {
    const instanceState = runtimeState()

    if (!instanceState.sweepTimer) return
    clearInterval(instanceState.sweepTimer)
    instanceState.sweepTimer = null
  }
  export function stop() {
    stopSweepTimer()
    runtimeState().activeTraces.clear()
  }

  export interface Input {
    agent: Agent.Info
    model: Provider.Model
    sessionID: string
    processor: SessionProcessor.Info
    session?: Info
    userTools?: Record<string, boolean>
    ephemeralTools?: EphemeralTool[]
    includeMCP?: boolean
    activeToolIDs?: string[]
  }

  export interface EphemeralTool {
    id: string
    description: string
    inputSchema: JSONSchema7
    display?: ToolDisplay
    execute(args: Record<string, unknown>): Promise<{
      title: string
      output: string
      metadata?: Record<string, any>
    }>
  }

  export interface Definition {
    id: string
    exposure?: ToolExposure.Info
    display?: ToolDisplay
    source?: Tool.Source
    diagnostic?: ToolDiagnosticInfo
    executor?: ToolExecutorKind
    description: string
    inputSchema: JSONSchema7
    createRuntimeTool?(input: Input): AITool
  }

  type RegistryTool = Awaited<ReturnType<typeof ToolRegistry.tools>>[number]

  export function registryInputSchema(item: {
    parameters: z.ZodType
    inputSchema?: Record<string, unknown>
  }): JSONSchema7 {
    return (item.inputSchema ?? z.toJSONSchema(item.parameters)) as JSONSchema7
  }

  export interface Availability {
    visible: Definition[]
    diagnostics: Map<string, ToolDiagnosticInfo>
    autoExpandable: Set<string>
  }

  export interface ResolvedTools {
    definitions: ToolCatalog.Definition[]
    executionTools: Record<string, AITool>
    executorKinds: Record<string, ToolExecutorKind>
    activeToolIDs: string[]
    autoExpandable: Set<string>
  }

  /** P9: plugin gate options are filled by the registered plugin source; an
   * unregistered source leaves them untouched, matching a host with no
   * loaded plugins. */
  async function configureGateOptions(options: GateOptions): Promise<GateOptions> {
    await SessionToolContext.plugin()?.configureGate(options)
    return options
  }

  /**
   * Derive an external path string from tool args for use in nonBypassable
   * permission asks triggered by the enforcement gate.
   */
  function externalPathFromArgs(toolName: string, args: Record<string, any>): string {
    if (toolName === "bash") return (args.workdir ?? args.command) as string
    if (toolName === "look_at" || toolName === "view_image" || toolName === "attach") {
      const raw = args.file_path ?? args.filePath ?? ""
      return Array.isArray(raw) ? (raw[0] ?? "") : String(raw)
    }
    return (args.filePath ?? args.path ?? args.pattern ?? "") as string
  }

  function permissionForGateCapability(toolName: string, className: string): string {
    if (className === "file_external_read" || className === "file_external_write") return "external_directory"
    if (className === "shell_remote_publish" || className === "shell_remote_write") return "bash"
    if (className === "shell_destructive") return "bash"
    if (className === "network_request") return toolName === "webfetch" ? toolName : "network_request"
    return className
  }

  function patternsForGateCapability(toolName: string, cap: Capability, args: Record<string, any>): string[] {
    if (cap.class === "file_external_read" || cap.class === "file_external_write")
      return cap.paths?.length ? cap.paths : [externalPathFromArgs(toolName, args) || "*"]
    if (cap.class === "shell_destructive" || cap.class === "shell_remote_publish" || cap.class === "shell_remote_write")
      return [String(args.command ?? "*")]
    if (cap.class === "network_request") return [String(args.url ?? args.query ?? "*")]
    if (cap.class === "communication_email") return [String(args.to ?? args.from ?? args.subject ?? "*")]
    if (cap.class === "identity_act") return [`${toolName} role=${args.role ?? "*"} to ${args.target ?? "*"}`]
    return ["*"]
  }

  function approvedExternalRoots(ctx: Tool.Context): string[] {
    return ((ctx.extra as any).approvedExternalRoots ?? []) as string[]
  }

  function shouldBypassShellSandbox(ctx: Tool.Context): boolean {
    return (ctx.extra as any).shellBypassSandbox === true
  }

  function markShellSandboxBypass(ctx: Tool.Context) {
    ;(ctx.extra as any).shellBypassSandbox = true
  }

  /** The resolver already decided this call's authorization. */
  function markShellAuthorizationResolved(ctx: Tool.Context) {
    ;(ctx.extra as any).shellAuthorizationResolved = true
  }

  /**
   * Record a shell authorization outcome for the execution layer.
   *
   * Two separate questions used to share the `shellBypassSandbox` flag, which is
   * what blocked authorization from following containment: the bash tool asked
   * for its own approval unless the sandbox was bypassed, so the only way to
   * stop it re-asking was to also switch the sandbox off.
   *
   * - `shellAuthorizationResolved` answers "may the tool ask again?" — never,
   *   because the resolver already decided.
   * - `shellBypassSandbox` answers "does this run without the sandbox?" — only
   *   when the sandbox is not what justified the decision. A contained call
   *   keeps its sandbox: the kernel is the boundary that authorized it.
   */
  function applyShellAuthorization(ctx: Tool.Context, profileId: string, containment?: SandboxContainment) {
    markShellAuthorizationResolved(ctx)
    if (containment?.contained === true) return
    if (profileId !== "autonomous") markShellSandboxBypass(ctx)
  }

  /**
   * A user or profile approval already crossed the shell boundary for this
   * call, so the tool must not ask again and the historical behavior — an
   * interactively approved shell command runs without the sandbox — is
   * preserved.
   */
  function rememberShellApproval(ctx: Tool.Context, permission: string, metadata: Record<string, unknown>) {
    const capability = String(metadata.capability ?? "")
    if (
      permission === "bash" ||
      capability === "shell" ||
      capability === "shell_remote_publish" ||
      capability === "shell_remote_write" ||
      capability === "shell_destructive"
    ) {
      markShellAuthorizationResolved(ctx)
      markShellSandboxBypass(ctx)
    }
  }

  function rememberApprovedExternalRoots(ctx: Tool.Context, patterns: string[]) {
    const roots = patterns.filter((pattern) => pattern.startsWith("/"))
    if (roots.length === 0) return
    ;(ctx.extra as any).approvedExternalRoots = [...new Set([...approvedExternalRoots(ctx), ...roots])]
  }

  interface ShellContainment {
    verdict: SandboxContainment
    release(): void
  }

  /**
   * Ask the sandbox host whether it will contain this bash call, before the
   * authorization decision is made.
   *
   * Authorization follows containment: the gate cannot decide a shell command
   * while assuming containment it may not get. The verdict is therefore
   * produced first, from the same host preparation execution uses, and handed
   * to the gate. Only the containment verdict is needed here — the sandbox
   * cannot be asked about the command's reach, and its availability is a
   * property of the platform and helper, not of the command text or roots — so
   * the prepared wrapper is released as soon as the decision is known and the
   * execution path prepares its own with the materialized command.
   *
   * `release` uses the host's existing cleanup contract rather than a second
   * one, which is what keeps a refused call from leaving its temporary profile
   * behind.
   */
  function prepareShellContainment(input: {
    gate: Awaited<ReturnType<typeof EnforcementGate.create>>
    ctx: Tool.Context
    workspace: string
    command: string
  }): ShellContainment | undefined {
    const sandbox = input.gate.getSandbox()
    if (sandbox.mode === "none" || shouldBypassShellSandbox(input.ctx)) return undefined
    const wrapper = SandboxHost.prepareWrapper({
      command: "/bin/sh",
      args: ["-c", input.command],
      workspace: input.workspace,
      sandboxMode: sandbox.mode,
      backend: sandbox.backend,
    })
    return {
      verdict: {
        contained: wrapper.sandboxed && !wrapper.skipReason,
        ...(wrapper.skipReason ? { skipReason: wrapper.skipReason } : {}),
      },
      release: () => SandboxHost.cleanupWrapper(wrapper),
    }
  }

  interface ToolTiming {
    requestedAt: number
    approvalStartedAt?: number
    approvalResolvedAt?: number
    approvalWaitMs: number
    activeApprovalStartedAt?: number
    executionStartedAt?: number
    toolTimeoutCleanup?: () => void
    sessionAbort: AbortSignal
  }

  function toolTiming(ctx: Tool.Context): ToolTiming {
    return (ctx.extra as any).toolTiming as ToolTiming
  }

  interface ToolTrace {
    traceId: string
    span: ObservabilitySpans.SpanContext | undefined
    phase(
      type: string,
      phase: string,
      data?: Record<string, unknown>,
      level?: Observability.Event["level"],
    ): Promise<void>
    end(data?: Record<string, unknown>): Promise<void>
    error(error: unknown, data?: Record<string, unknown>): Promise<void>
    dispose(): void
  }

  async function startToolTrace(
    input: Input,
    ctx: Tool.Context,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolTrace> {
    const instanceState = runtimeState()

    const startedAt = Date.now()
    let phase = "start"
    let lastActivity = startedAt
    const stalledMs = await stalledToolMs()
    const scopeID = ScopeContext.current.scope.id
    const cwd = ScopeContext.current.workspace
      ? ObservabilityRedaction.cwdScope(ScopeContext.current.workspace.path)
      : undefined
    const span = ObservabilitySpans.start({
      name: "tool.execution",
      module: "tool",
      scopeID,
      sessionID: input.sessionID,
      messageID: input.processor.message.id,
      callID: ctx.callID,
      tool: toolName,
      attributes: { tool: toolName },
    })
    const traceId = span?.traceId ?? Observability.traceId("tool")
    const activeTraceKey = span?.spanId ?? Observability.traceId("active_tool")
    ;(ctx.extra as any).traceId = traceId
    ObservabilityMetrics.record({
      name: "tool.execution.count",
      value: 1,
      unit: "count",
      module: "tool",
      traceId,
      spanId: span?.spanId,
      parentSpanId: span?.parentSpanId,
      sessionID: input.sessionID,
      messageID: input.processor.message.id,
      callID: ctx.callID,
      tool: toolName,
    })
    const base = () => ({
      traceId,
      sessionID: input.sessionID,
      messageID: input.processor.message.id,
      callID: ctx.callID,
      tool: toolName,
      cwd,
      scopeID,
    })
    const emit = (type: string, data?: Record<string, unknown>, level?: Observability.Event["level"]) =>
      Observability.emit(type, {
        ...base(),
        level,
        data: {
          phase,
          elapsedMs: Date.now() - startedAt,
          ...data,
        },
      })

    await emit("tool.start", { tool: toolName })

    const entry: ActiveTraceEntry = {
      traceId,
      startedAt,
      lastActivity: startedAt,
      lastHeartbeat: startedAt,
      stalled: false,
      stalledMs,
      phase: "start",
      span,
      sessionID: input.sessionID,
      messageID: input.processor.message.id,
      callID: ctx.callID,
      toolName,
      cwd,
      scopeID,
    }
    instanceState.activeTraces.set(activeTraceKey, entry)
    ensureSweepTimer()

    return {
      traceId,
      span,
      async phase(type, nextPhase, data, level) {
        const previousPhase = phase
        phase = nextPhase
        const now = Date.now()
        entry.phase = nextPhase
        entry.lastActivity = now
        ObservabilitySpans.activity(span, { phase: nextPhase })
        ObservabilityMetrics.record({
          name: "tool.phase.duration",
          value: now - lastActivity,
          unit: "ms",
          module: "tool",
          traceId,
          spanId: span?.spanId,
          sessionID: input.sessionID,
          messageID: input.processor.message.id,
          callID: ctx.callID,
          tool: toolName,
          labels: { phase: previousPhase, nextPhase },
        })
        lastActivity = now
        await emit(type, data, level)
      },
      async end(data) {
        phase = "end"
        lastActivity = Date.now()
        entry.lastActivity = lastActivity
        await emit("tool.end", data)
        ObservabilitySpans.end(span, { attributes: data })
      },
      async error(error, data) {
        phase = "error"
        lastActivity = Date.now()
        entry.lastActivity = lastActivity
        await emit(
          "tool.error",
          {
            ...data,
            error: ObservabilityRedaction.errorInfo(error),
          },
          "error",
        )
        ObservabilityMetrics.record({
          name: "tool.execution.error",
          value: 1,
          unit: "count",
          module: "tool",
          traceId,
          spanId: span?.spanId,
          sessionID: input.sessionID,
          messageID: input.processor.message.id,
          callID: ctx.callID,
          tool: toolName,
          labels: { errorName: error instanceof Error ? error.name : "unknown" },
        })
        ObservabilitySpans.end(span, { status: "error", error, attributes: data })
      },
      dispose() {
        instanceState.activeTraces.delete(activeTraceKey)
        if (instanceState.activeTraces.size === 0) stopSweepTimer()
      },
    }
  }

  async function stalledToolMs() {
    try {
      const cfg = await Config.current()
      return cfg.observability?.stalledToolMs ?? DEFAULT_STALLED_TOOL_MS
    } catch {
      return DEFAULT_STALLED_TOOL_MS
    }
  }

  function approvalTime(timing: ToolTiming): ApprovalMetadata["time"] {
    return {
      requestedAt: timing.requestedAt,
      approvalStartedAt: timing.approvalStartedAt,
      approvalResolvedAt: timing.approvalResolvedAt,
      executionStartedAt: timing.executionStartedAt,
      approvalWaitMs: timing.approvalWaitMs || undefined,
    }
  }

  function stampApprovalTiming(ctx: Tool.Context, approval: ApprovalMetadata): ApprovalMetadata {
    const timing = toolTiming(ctx)
    const now = Date.now()

    if (approval.status === "pending_user") {
      timing.approvalStartedAt ??= now
      timing.activeApprovalStartedAt = now
    } else if (approval.status === "user_allowed" || approval.status === "user_denied") {
      timing.approvalResolvedAt = now
      if (timing.activeApprovalStartedAt !== undefined) {
        timing.approvalWaitMs += Math.max(0, now - timing.activeApprovalStartedAt)
        timing.activeApprovalStartedAt = undefined
      }
    } else if (
      approval.status === "auto_allowed" ||
      approval.status === "auto_denied" ||
      approval.status === "policy_denied" ||
      approval.status === "sandbox_blocked" ||
      approval.status === "not_required" ||
      approval.status === "pre_authorized"
    ) {
      timing.approvalResolvedAt ??= now
    }

    return {
      ...approval,
      time: approvalTime(timing),
    }
  }

  async function updateRunningToolPart(
    input: Input,
    ctx: Tool.Context,
    args: Record<string, any>,
    state: {
      title?: string
      metadata?: Record<string, any>
      start?: number
    },
  ) {
    if (!ctx.callID) return
    await input.processor.updateToolCallState(ctx.callID, {
      input: args,
      ...state,
    })
  }

  async function markExecutionStarted(
    input: Input,
    ctx: Tool.Context,
    args: Record<string, any>,
    toolTimeout: ToolTimeout.Metadata,
  ) {
    const timing = toolTiming(ctx)
    if (timing.executionStartedAt !== undefined) return

    timing.executionStartedAt = Date.now()
    const approval = approvalFromContext(ctx)
    if (approval) {
      ;(ctx.extra as any).approval = {
        ...approval,
        time: approvalTime(timing),
      } satisfies ApprovalMetadata
    }

    const metadata = {
      toolTimeout,
      ...(approvalFromContext(ctx) ? { approval: approvalFromContext(ctx) } : {}),
    }
    ;(ctx.extra as any).toolTimeout = toolTimeout
    await updateRunningToolPart(input, ctx, args, {
      metadata,
      start: timing.executionStartedAt,
    })
  }

  function startToolTimeout(ctx: Tool.Context, timeoutMs: number) {
    const timing = toolTiming(ctx)
    const timeout = new AbortController()
    const timeoutError = new DOMException(`Tool execution timed out after ${timeoutMs}ms`, "TimeoutError")
    const timer = setTimeout(() => timeout.abort(timeoutError), timeoutMs)
    if (typeof timer === "object" && "unref" in timer) timer.unref()
    timing.toolTimeoutCleanup = () => {
      clearTimeout(timer)
      timing.toolTimeoutCleanup = undefined
    }
    return AbortSignal.any([timing.sessionAbort, timeout.signal])
  }

  function settleExecutionOnAbort<T>(execute: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new DOMException("Tool execution aborted", "AbortError"))
    }

    return new Promise<T>((resolve, reject) => {
      function cleanup() {
        signal.removeEventListener("abort", abort)
      }
      function abort() {
        cleanup()
        reject(signal.reason ?? new DOMException("Tool execution aborted", "AbortError"))
      }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }

      let execution: Promise<T>
      try {
        execution = execute()
      } catch (error) {
        cleanup()
        reject(error)
        return
      }
      execution.then(
        (result) => {
          cleanup()
          resolve(result)
        },
        (error) => {
          cleanup()
          reject(error)
        },
      )
    })
  }

  function triggerToolHook<Input, Output>(
    point: "tool.execute.before" | "tool.execute.after",
    input: Input,
    output: Output,
    signal: AbortSignal,
  ) {
    const source = SessionToolContext.plugin()
    return settleExecutionOnAbort(
      () => (source ? source.triggerToolHooks(point, input, output, { signal }) : Promise.resolve(output)),
      signal,
    )
  }

  function disposeToolTimeout(ctx: Tool.Context) {
    toolTiming(ctx).toolTimeoutCleanup?.()
  }

  async function applyGateApproval(
    ctx: Tool.Context,
    gate: Awaited<ReturnType<typeof EnforcementGate.create>>,
    envelope: ReturnType<Awaited<ReturnType<typeof EnforcementGate.create>>["evaluate"]>,
    toolName: string,
    args: Record<string, any>,
    input: Input,
  ) {
    const session = input.session
    const profile = gate.getProfileInfo()
    const approval = profile.approval
    const policyDecision = ApprovalPolicy.decideCapabilities(profile, envelope.capabilities)
    // envelope.decision is authoritative — the gate already merged profile rules,
    // exec-policy, and approval cache. policyDecision provides risk/capabilities
    // metadata only; its .action is discarded.
    const decision = { ...policyDecision, action: envelope.decision }

    // Profile already permits the operation — no need for Smart allow.
    if (decision.action === "allow") {
      await setApprovalMetadata(ctx, ApprovalPolicy.metadata(approval, decision, "auto_allowed"))
      // Autonomous runs unattended: profile-auto-allowed bash stays inside the
      // OS sandbox (workspace_write) instead of bypassing it, so writes that
      // static classification cannot see (variable redirect targets) are still
      // contained at execution time. Guarded/full_access keep the historical
      // bypass for user-approved interactive work.
      if (toolName === "bash") applyShellAuthorization(ctx, profile.profileId, envelope.containment)
      return
    }

    const smartAllowEligible = SmartAllow.isEligible(decision.action, envelope.capabilities)

    // User/session rules: check persistent user rules (from "Always allow"
    // button) and ephemeral session rules. Deny always wins. Allow only
    // bypasses soft asks; non-bypassable asks must still reach the user.
    if (decision.action === "ask" || decision.action === "deny") {
      const patterns = [
        PermissionRules.extractPattern(toolName, args),
        ...envelope.capabilities.flatMap((cap) => patternsForGateCapability(toolName, cap, args)),
      ]
      const userRules = await PermissionRules.userRuleset()
      const sessionRules = PermissionRules.sessionRuleset(session?.id)
      const ruleDecisions = [...new Set(patterns)].map((pattern) =>
        PermissionRules.evaluate(toolName, pattern, userRules, sessionRules),
      )
      const ruleDecision =
        ruleDecisions.find((item) => item.action === "deny") ??
        ruleDecisions.find((item) => item.action === "allow") ??
        ({ action: "ask" } as const)
      if (ruleDecision.action === "deny") {
        await setApprovalMetadata(ctx, {
          ...ApprovalPolicy.metadata(approval, decision, "auto_denied"),
          source: "user",
          reason: `Denied by user rule: ${ruleDecision.rule?.permission}(${ruleDecision.rule?.pattern})`,
        })
        throw new EnforcementError.PolicyDenied(
          `Blocked by user permission rule: ${ruleDecision.rule?.permission ?? toolName}(${ruleDecision.rule?.pattern ?? patterns[0]})`,
          decision.capabilities,
          envelope.profileId,
        )
      }
      if (decision.action === "ask" && ruleDecision.action === "allow" && smartAllowEligible) {
        await setApprovalMetadata(ctx, {
          ...ApprovalPolicy.metadata(approval, decision, "auto_allowed"),
          source: "user",
          reason: `Allowed by user rule: ${ruleDecision.rule?.permission}(${ruleDecision.rule?.pattern})`,
        })
        if (toolName === "bash") applyShellAuthorization(ctx, profile.profileId, envelope.containment)
        return
      }
      // ask → fall through to Smart allow / gateOwnedAsks; deny → Smart allow or policy denial.
    }

    if (smartAllowEligible) {
      const cfg = await Config.current()
      if (cfg.smartAllow === true && !SmartAllow.isDisabled(ctx.sessionID)) {
        const redactedEvidence = SmartAllow.buildRedactedEvidence(args, envelope.capabilities)
        const context = await smartAllowContext(input, ctx)
        const classification = await SmartAllow.classify({
          sessionID: ctx.sessionID,
          rootID: input.processor.message.rootID ?? input.processor.message.parentID,
          tool: toolName,
          args,
          capabilities: envelope.capabilities.map((c) => c.class),
          workspace: ScopeContext.current.workspace?.path ?? null,
          policyAction: decision.action,
          redactedEvidence,
          ...(context ?? {}),
        })
        if (SmartAllow.shouldAutoAllow(classification, ctx.sessionID, decision.action)) {
          await setApprovalMetadata(ctx, {
            ...ApprovalPolicy.metadata(approval, decision, "auto_allowed"),
            source: "smart_allow",
            reason: `Auto-allowed by Smart allow: ${classification!.reason} (confidence ${classification!.confidence.toFixed(2)})`,
          })
          if (toolName === "bash") applyShellAuthorization(ctx, profile.profileId, envelope.containment)
          return
        }
        if (classification) {
          ;(ctx.extra as any).smartAllowRisk = classification
        }
      }
    }

    if (decision.action === "deny") {
      // Use the refusal's diagnostic reason when available — this carries
      // specific detail like "matched destructive pattern: git push" that
      // should be visible both in the error message AND the frontend audit tooltip.
      const diagnosticReason = envelope.refusal?.reason ?? decision.reason
      const metadata = ApprovalPolicy.metadata(approval, decision, "auto_denied")
      let smartAllow: ApprovalMetadata["smartAllow"] | undefined
      if ((ctx.extra as any).smartAllowRisk) {
        smartAllow = (ctx.extra as any).smartAllowRisk
      } else if (!smartAllowEligible) {
        smartAllow = { skipped: true, reason: "Non-bypassable capability" }
      }
      await setApprovalMetadata(ctx, { ...metadata, reason: diagnosticReason, ...(smartAllow ? { smartAllow } : {}) })
      throw new EnforcementError.PolicyDenied(diagnosticReason, decision.capabilities, envelope.profileId, {
        permanent: envelope.refusal?.permanent ?? true,
        guidance: envelope.refusal?.guidance,
      })
    }

    if (profile.profileId === "autonomous" && decision.action === "ask") {
      const diagnosticReason = envelope.refusal?.reason ?? decision.reason
      const metadata = ApprovalPolicy.metadata(approval, { ...decision, action: "deny" }, "auto_denied")
      let smartAllow: ApprovalMetadata["smartAllow"] | undefined
      if ((ctx.extra as any).smartAllowRisk) {
        smartAllow = (ctx.extra as any).smartAllowRisk
      } else if (!smartAllowEligible) {
        smartAllow = { skipped: true, reason: "Non-bypassable capability" }
      }
      await setApprovalMetadata(ctx, { ...metadata, reason: diagnosticReason, ...(smartAllow ? { smartAllow } : {}) })
      throw new EnforcementError.PolicyDenied(diagnosticReason, decision.capabilities, envelope.profileId, {
        permanent: envelope.refusal?.permanent ?? true,
        guidance: envelope.refusal?.guidance,
      })
    }

    // Pre-authorization origin: sessions created by system scheduling (e.g. agenda wake)
    // may pre-authorize specific tools to bypass the ask gate. This only
    // applies within this session and cannot override profile denies,
    // protected paths, or explicit user deny rules.
    const preAuthorized = session?.preAuthorizedActions ?? []
    if (decision.action === "ask" && preAuthorized.includes(toolName)) {
      await setApprovalMetadata(ctx, {
        ...ApprovalPolicy.metadata(approval, decision, "pre_authorized"),
        source: "provenance",
        reason: `Pre-authorized by system scheduling (session inherits trust from agenda wake)`,
      })
      if (toolName === "bash") applyShellAuthorization(ctx, profile.profileId, envelope.containment)
      return
    }

    const gateOwnedAsks = envelope.capabilities.filter((cap) => {
      if (!cap.nonBypassable && !cap.opaque) return false
      if (!gate.hasPendingCapability(cap.class)) return false
      // These tools already perform the exact same non-bypassable ask with
      // richer, tool-specific metadata before crossing the boundary.
      if (toolName === "email_send" && cap.class === "communication_email") return false
      if (toolName === "session_send" && cap.class === "identity_act") return false
      if (toolName === "webfetch" && cap.class === "network_request") return false
      if (toolName === "email_read" && cap.class === "communication_email") return false
      return true
    })

    if (gateOwnedAsks.length === 0) return

    await setApprovalMetadata(ctx, ApprovalPolicy.metadata(approval, decision, "pending_user"))

    for (const cap of gateOwnedAsks) {
      const patterns = patternsForGateCapability(toolName, cap, args)
      await ctx.ask({
        permission: permissionForGateCapability(toolName, cap.class),
        patterns,
        metadata: {
          nonBypassable: true,
          capability: cap.class,
          opaque: cap.opaque === true,
          ...(cap.class === "file_external_read" || cap.class === "file_external_write"
            ? { workspaceBoundary: true, outsideWorkspace: true }
            : {}),
        },
      })
      if (cap.class === "file_external_read" || cap.class === "file_external_write")
        rememberApprovedExternalRoots(ctx, patterns)
      gate.resolveCapability(cap.class)
    }
  }

  function controlProfileForContext(ctx: Tool.Context | undefined): string | undefined {
    const profileId = (ctx?.extra as { controlProfile?: unknown } | undefined)?.controlProfile
    return typeof profileId === "string" && profileId.length > 0 ? profileId : undefined
  }

  /**
   * Ask the user to approve the exact path a sandbox denial named, then carry
   * that approval into later tool calls.
   *
   * A sandbox denial happens while the command is already running, so the
   * denied path never reached the gate's own ask pass. `guarded` is the only
   * profile that may prompt: `autonomous` stays fail-closed and `full_access`
   * never reaches a sandbox at all. Only an outside-the-write-roots boundary is
   * approvable — a blocked read is not something the profile ruleset turns into
   * a real prompt, so promising it would be dishonest. The approval is
   * remembered for the session and re-seeded into the sandbox roots of the next
   * call, so retrying the same command succeeds instead of being denied again.
   */
  async function requestSandboxDenialApproval(
    error: EnforcementError.SandboxBlocked,
    ctx: Tool.Context,
    input: Input,
  ): Promise<void> {
    if (controlProfileForContext(ctx) !== "guarded") return
    const target = approvablePath(error.explanation)
    if (!target || target.access !== "write") return

    try {
      await ctx.ask({
        permission: "external_directory",
        patterns: [target.path],
        metadata: {
          nonBypassable: true,
          capability: "file_external_write",
          workspaceBoundary: true,
          outsideWorkspace: true,
          sandboxDeniedPath: target.path,
          sandboxDeniedAccess: target.access,
        },
      })
    } catch (approvalError) {
      log.debug("sandbox denial path not approved", {
        sessionID: input.sessionID,
        path: target.path,
        access: target.access,
        error: errorMessage(approvalError),
      })
      return
    }

    SandboxSessionApproval.remember(input.session?.id ?? ctx.sessionID, target.path, target.access)
    ;(ctx.extra as any).sandboxDeniedApproved = target
    log.info("sandbox denial path approved", {
      sessionID: input.sessionID,
      path: target.path,
      access: target.access,
    })
  }

  function formatErrorForModel(error: unknown, ctx?: Tool.Context): string {
    if (error instanceof ToolDiagnosticError) {
      return error.message
    }

    if (error instanceof EnforcementError.PolicyDenied) {
      return error.modelMessage
    }

    if (error instanceof EnforcementError.SandboxBlocked) {
      return formatExplanationForModel(error.explanation, {
        controlProfile: controlProfileForContext(ctx),
        approved: ((ctx?.extra as any)?.sandboxDeniedApproved as { path: string; access: "read" | "write" }) ?? null,
        message: error.message,
      })
    }

    if (error instanceof EnforcementError.BoundaryHit) {
      return [
        `Path "${error.path}" is outside the workspace boundary.`,
        `The current permission profile restricts access to workspace paths only.`,
        `Use a workspace-relative path or the dedicated file tools (view_file, scan_files, etc.).`,
        `Do not retry with this path.`,
      ].join("\n")
    }

    return (error as any).toString()
  }

  function metadataForError(error: unknown, approval?: ApprovalMetadata): Record<string, any> | undefined {
    const diagnostic = ToolDiagnostic.fromError(error)
    const metadata = {
      ...(diagnostic ? ToolDiagnostic.metadata(diagnostic) : {}),
      ...(approval ? { approval } : {}),
    }
    return Object.keys(metadata).length > 0 ? metadata : undefined
  }

  async function setApprovalMetadata(ctx: Tool.Context, approval: ApprovalMetadata) {
    const stamped = ApprovalPolicy.withAudit(stampApprovalTiming(ctx, approval))
    ;(ctx.extra as any).approval = stamped
    await ctx.metadata({ metadata: { approval: stamped } })
  }

  function approvalFromContext(ctx: Tool.Context): ApprovalMetadata | undefined {
    return (ctx.extra as any).approval
  }

  async function smartAllowContext(input: Input, ctx: Tool.Context) {
    const agentContext = [input.agent.name, input.agent.description].filter(Boolean).join(": ")
    const userMessageID = (ctx.extra as { userMessageID?: unknown }).userMessageID
    let userMessage: string | undefined

    if (typeof userMessageID === "string") {
      try {
        const message = await MessageV2.get({ sessionID: input.sessionID, messageID: userMessageID })
        if (message.info.role === "user") {
          userMessage = SmartAllow.redactContextText(MessageV2.extractText(message.parts, { maxLength: 1_600 }), 1_000)
        }
      } catch (error) {
        log.debug("smart allow user message context unavailable", {
          sessionID: input.sessionID,
          messageID: userMessageID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const newest: MessageV2.WithParts[] = []
    try {
      for await (const message of MessageV2.stream({ sessionID: input.sessionID })) {
        newest.push(message)
        if (newest.length >= 4) break
      }
    } catch (error) {
      log.debug("smart allow recent history unavailable", {
        sessionID: input.sessionID,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    const recentHistory = newest
      .reverse()
      .filter((message) => MessageV2.isPromptVisible(message))
      .map((message) => {
        const text = SmartAllow.redactContextText(MessageV2.extractText(message.parts, { maxLength: 1_000 }), 600)
        return text ? `${message.info.role}: ${text}` : undefined
      })
      .filter((item): item is string => !!item)

    if (!userMessage && recentHistory.length === 0 && !agentContext) return undefined
    return {
      ...(userMessage ? { userMessage } : {}),
      ...(recentHistory.length ? { recentHistory } : {}),
      ...(agentContext ? { agentContext: SmartAllow.redactContextText(agentContext, 500) } : {}),
    }
  }

  function contextFactory(input: Input) {
    return (args: any, options: ToolCallOptions): Tool.Context => {
      const resolveCurrentProfile = async (): Promise<ResolvedProfile> => {
        const profileId = await Session.resolveEffectiveControlProfile({
          sessionID: input.session?.id,
          agentControlProfile: input.agent.controlProfile,
        })
        const workspaceInfo = ScopeContext.current.workspace
        return ControlProfileCompiler.resolve(profileId, {
          workspace: ScopeContext.current.workspace?.path ?? null,
          workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
        })
      }
      let profilePromise: Promise<ResolvedProfile> | undefined
      const resolvedProfile = async (): Promise<ResolvedProfile> => {
        profilePromise ??= resolveCurrentProfile()
        return profilePromise
      }
      const match = input.processor.partFromToolCall(options.toolCallId)
      const sessionAbort = options.abortSignal ?? neverAbort
      const ctx: Tool.Context = {
        sessionID: input.sessionID,
        abort: sessionAbort,
        messageID: input.processor.message.id,
        callID: options.toolCallId,
        captureResult: RolloutTool.capture,
        openProcessEvidence: RolloutTool.openProcess,
        extra: {
          model: input.model,
          lookAtAvailable: input.activeToolIDs?.includes("look_at") === true,
          userTools: input.userTools,
          availableToolIDs: input.activeToolIDs ?? [],
          userMessageID: input.processor.message.parentID,
          toolTiming: {
            requestedAt: match?.state.status === "running" ? match.state.time.start : Date.now(),
            approvalWaitMs: 0,
            sessionAbort,
          } satisfies ToolTiming,
          controlProfile: input.agent.controlProfile,
        },
        agent: input.agent.name,
        metadata: async (val: { title?: string; metadata?: any }) => {
          const approval = approvalFromContext(ctx)
          await updateRunningToolPart(input, ctx, args as Record<string, any>, {
            title: val.title,
            metadata: approval ? { ...val.metadata, approval } : val.metadata,
          })
        },
        async ask(req) {
          const profile = await resolvedProfile()
          const requestMetadata = req.metadata ?? {}
          const decision = ApprovalPolicy.decidePermission(profile, req.permission, requestMetadata)
          if (decision.action === "deny") {
            const approval = ApprovalPolicy.metadata(profile.approval, decision, "auto_denied")
            await setApprovalMetadata(ctx, approval)
            throw new EnforcementError.PolicyDenied(
              decision.reason,
              decision.capabilities,
              profile.summary?.profileId ?? "unknown",
            )
          }
          if (profile.summary?.profileId === "full_access") {
            await setApprovalMetadata(
              ctx,
              ApprovalPolicy.metadata(profile.approval, { ...decision, action: "allow" }, "auto_allowed"),
            )
            rememberShellApproval(ctx, req.permission, requestMetadata)
            return
          }

          if (profile.summary?.profileId === "autonomous" && decision.action === "ask") {
            const approval = ApprovalPolicy.metadata(profile.approval, { ...decision, action: "deny" }, "auto_denied")
            await setApprovalMetadata(ctx, approval)
            throw new EnforcementError.PolicyDenied(
              decision.reason,
              decision.capabilities,
              profile.summary?.profileId ?? "unknown",
            )
          }

          if (decision.action === "allow") {
            await setApprovalMetadata(ctx, ApprovalPolicy.metadata(profile.approval, decision, "auto_allowed"))
            return
          }

          await setApprovalMetadata(ctx, ApprovalPolicy.metadata(profile.approval, decision, "pending_user"))
          const forcedAsk = [{ permission: req.permission, pattern: "*", action: "ask" as const }]
          try {
            const freshProfile = await resolveCurrentProfile()
            if (freshProfile.summary?.profileId === "full_access") {
              await setApprovalMetadata(
                ctx,
                ApprovalPolicy.metadata(freshProfile.approval, { ...decision, action: "allow" }, "auto_allowed"),
              )
              rememberShellApproval(ctx, req.permission, requestMetadata)
              return
            }
            await PermissionNext.ask({
              ...req,
              sessionID: input.sessionID,
              tool: { messageID: input.processor.message.id, callID: options.toolCallId },
              metadata: requestMetadata,
              ruleset: PermissionNext.merge(
                input.agent.permission,
                PermissionNext.sessionRuleset(input.session),
                forcedAsk,
              ),
              signal: ctx.abort,
            })
            if (
              (requestMetadata as Record<string, unknown>).workspaceBoundary ||
              (requestMetadata as Record<string, unknown>).outsideWorkspace
            ) {
              rememberApprovedExternalRoots(ctx, req.patterns)
            }
            rememberShellApproval(ctx, req.permission, requestMetadata)
            await setApprovalMetadata(ctx, ApprovalPolicy.metadata(profile.approval, decision, "user_allowed"))
            SmartAllow.recordUserFeedback(ctx.sessionID, (ctx.extra as any).smartAllowRisk, true)
          } catch (error) {
            if (error instanceof PermissionNext.RejectedError || error instanceof PermissionNext.CorrectedError) {
              await setApprovalMetadata(ctx, ApprovalPolicy.metadata(profile.approval, decision, "user_denied"))
              SmartAllow.recordUserFeedback(ctx.sessionID, (ctx.extra as any).smartAllowRisk, false)
            }
            throw error
          }
        },
      }
      return ctx
    }
  }

  function forcedTools(userTools?: Record<string, boolean>) {
    return Object.entries(userTools ?? {})
      .filter(([id, enabled]) => id !== "*" && enabled === true)
      .map(([id]) => id)
  }

  async function hasAvailableVisionModel(): Promise<boolean> {
    const agent = await Agent.get("multimodal-looker")
    if (!agent) return false
    const modelRef = await Agent.getAvailableModel(agent)
    if (!modelRef) return false
    const model = await Provider.getModel(modelRef.providerID, modelRef.modelID).catch(() => undefined)
    return model?.capabilities.input.image === true
  }

  async function applyAvailability(defs: Definition[], input: Omit<Input, "processor">): Promise<Availability> {
    const visible: Definition[] = []
    const diagnostics = new Map<string, ToolDiagnosticInfo>()
    const autoExpandable = new Set<string>()
    const disabled = PermissionNext.disabled(
      defs.map((item) => item.id),
      PermissionNext.merge(input.agent.permission, PermissionNext.sessionRuleset(input.session)),
    )
    const forcedGroups = SessionModePolicy.forcedGroups(input.session)
    const forcedToolIDs = forcedTools(input.userTools)
    const ephemeralToolIds = new Set(input.ephemeralTools?.map((item) => item.id) ?? [])
    const domainAvailability = await SessionModePolicy.availability({ session: input.session, agent: input.agent.name })

    const supportsImageInput = input.model.capabilities.input.image
    const hasImageFormatRestrictions = !!input.model.capabilities.input.supportedImageMediaTypes?.length
    const lookAtAvailable = (!supportsImageInput || hasImageFormatRestrictions) && (await hasAvailableVisionModel())

    for (const def of defs) {
      if (def.diagnostic) {
        diagnostics.set(def.id, def.diagnostic)
        continue
      }

      const isEphemeral = ephemeralToolIds.has(def.id)
      if (!isEphemeral && def.id === "look_at" && !lookAtAvailable) continue
      if (!isEphemeral && def.id === "view_image" && !supportsImageInput) continue

      const modeDiagnostic = isEphemeral
        ? undefined
        : SessionModePolicy.visibility({ toolName: def.id, session: input.session })
      if (modeDiagnostic) {
        diagnostics.set(def.id, modeDiagnostic)
        continue
      }

      if (
        !ToolExposure.isVisible(def.id, def.exposure, input.session?.toolState, {
          forcedGroups,
          forcedTools: forcedToolIDs,
        })
      ) {
        const normalized = ToolExposure.normalize(def.id, def.exposure)
        if (
          (normalized.mode === "group" || normalized.mode === "search") &&
          !isEphemeral &&
          !disabled.has(def.id) &&
          ToolExposure.userAllows(def.id, input.userTools) &&
          !disabled.has("expand_tools") &&
          ToolExposure.userAllows("expand_tools", input.userTools)
        ) {
          autoExpandable.add(def.id)
        }
        diagnostics.set(
          def.id,
          SessionModePolicy.unavailable({
            toolName: def.id,
            reason: "deferred",
            session: input.session,
            metadata: { exposure: def.exposure },
          }),
        )
        continue
      }

      const domainDiagnostic = domainAvailability.get(def.id)
      if (domainDiagnostic && !isEphemeral) {
        diagnostics.set(def.id, domainDiagnostic)
        continue
      }

      if (disabled.has(def.id) && !isEphemeral) {
        diagnostics.set(
          def.id,
          SessionModePolicy.unavailable({
            toolName: def.id,
            reason: "permission",
            session: input.session,
          }),
        )
        continue
      }

      if (!ToolExposure.userAllows(def.id, input.userTools)) {
        diagnostics.set(
          def.id,
          SessionModePolicy.unavailable({
            toolName: def.id,
            reason: "user_disabled",
            session: input.session,
          }),
        )
        continue
      }

      visible.push(def)
    }

    return { visible, diagnostics, autoExpandable }
  }

  function diagnosticRuntimeTool(input: Input, diagnostic: ToolDiagnosticInfo): AITool {
    const schema = {
      type: "object",
      additionalProperties: true,
    } satisfies JSONSchema7

    return tool({
      id: diagnostic.toolName as any,
      description: diagnostic.message,
      inputSchema: jsonSchema(schema),
      async execute(args: Record<string, unknown>, options: ToolCallOptions) {
        log.info("tool.execute.callback.start", {
          tool: diagnostic.toolName,
          sessionID: input.sessionID,
          messageID: input.processor.message.id,
          callID: options.toolCallId,
          kind: "diagnostic",
        })
        const slot = input.processor.beginExecution(options.toolCallId)
        log.info("tool.execute.callback.slot", {
          tool: diagnostic.toolName,
          sessionID: input.sessionID,
          messageID: input.processor.message.id,
          callID: options.toolCallId,
          kind: "diagnostic",
          slotStatus: slot.status,
        })
        const error = new ToolDiagnosticError({
          ...diagnostic,
          metadata: {
            ...(diagnostic.metadata ?? {}),
            attemptedInput: args as Record<string, unknown>,
          },
        })
        ObservabilityToolFailures.record({
          tool: diagnostic.toolName,
          sessionID: input.sessionID,
          messageID: input.processor.message.id,
          callID: options.toolCallId,
          scopeID: ScopeContext.current.scope.id,
          phase: "tool.availability",
          error,
          errorClass: diagnostic.code,
          owner: "diagnostic",
        })
        RolloutTool.afterCommit(() => slot.fail(args, error.message, ToolDiagnostic.metadata(error.diagnostic)))
        throw error
      },
      toModelOutput(result: { output: string }) {
        return {
          type: "text",
          value: result.output,
        }
      },
    } as any) as AITool
  }

  function toolSchemaDiagnostic(item: RegistryTool, error: unknown): ToolDiagnosticInfo {
    const source = item.source
    const message =
      source?.type === "plugin"
        ? `Plugin tool ${item.id} declares an invalid JSON Schema input: ${errorMessage(error)}`
        : `Tool ${item.id} has an invalid input schema: ${errorMessage(error)}`
    const metadata: Record<string, unknown> = {
      source,
      originalError: errorMessage(error),
    }
    if (source?.type === "plugin") {
      metadata.pluginId = source.pluginId
      metadata.pluginToolId = source.toolId
      metadata.runtimeMode = source.runtimeMode
    }
    return {
      code: "tool_unavailable",
      toolName: item.id,
      message,
      metadata,
    }
  }

  function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === "string") return error
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }

  async function collectDefinitions(input: Omit<Input, "processor">): Promise<Definition[]> {
    using _ = log.time("definitions.collect")
    let result: Definition[] = []

    for (const item of input.ephemeralTools ?? []) {
      const schema = ProviderTransform.schema(input.model, item.inputSchema as any, {
        tool: item.id,
      }) as JSONSchema7
      result.push({
        id: item.id,
        exposure: { mode: "internal" },
        display: item.display,
        description: item.description,
        inputSchema: schema,
        executor: "control_plane",
        createRuntimeTool(runtimeInput) {
          const context = contextFactory(runtimeInput)
          return tool({
            id: item.id as any,
            description: item.description,
            inputSchema: jsonSchema(schema as any),
            async execute(args, options) {
              log.info("tool.execute.callback.start", {
                tool: item.id,
                sessionID: runtimeInput.sessionID,
                messageID: runtimeInput.processor.message.id,
                callID: options.toolCallId,
                kind: "ephemeral",
              })
              const slot = runtimeInput.processor.beginExecution(options.toolCallId)
              const ctx = context(args, options)
              let toolTrace: ToolTrace | undefined
              log.info("tool.execute.callback.slot", {
                tool: item.id,
                sessionID: runtimeInput.sessionID,
                messageID: runtimeInput.processor.message.id,
                callID: options.toolCallId,
                kind: "ephemeral",
                slotStatus: slot.status,
              })
              try {
                toolTrace = await startToolTrace(runtimeInput, ctx, item.id, args as Record<string, unknown>)
                await toolTrace.phase("tool.execute.start", "tool.execute")
                const result = await item.execute(args as Record<string, unknown>)
                RolloutTool.afterCommit(() =>
                  slot.complete(args, {
                    title: result.title,
                    output: result.output,
                    metadata: result.metadata ?? {},
                  }),
                )
                await toolTrace.end({ status: "completed" })
                return {
                  title: result.title,
                  output: result.output,
                  metadata: result.metadata ?? {},
                }
              } catch (error) {
                await toolTrace?.error(error, { phase: "tool.execute" })
                const message = error instanceof Error ? error.message : String(error)
                ObservabilityToolFailures.raiseIssue({
                  tool: item.id,
                  sessionID: runtimeInput.sessionID,
                  messageID: runtimeInput.processor.message.id,
                  callID: options.toolCallId,
                  traceId: toolTrace?.traceId,
                  spanId: toolTrace?.span?.spanId,
                  scopeID: toolTrace?.span?.scopeID,
                  phase: "tool.execute",
                  error,
                  owner: "ephemeral",
                })
                RolloutTool.afterCommit(() => slot.fail(args, message))
                throw error
              } finally {
                toolTrace?.dispose()
              }
            },
            toModelOutput(result) {
              return {
                type: "text",
                value: result.output,
              }
            },
          })
        },
      })
    }

    for (const item of await ToolRegistry.tools(input.model.providerID, input.agent)) {
      let schema: JSONSchema7
      try {
        schema = ProviderTransform.schema(input.model, registryInputSchema(item) as any, {
          tool: item.id,
        }) as JSONSchema7
      } catch (error) {
        if (item.source?.type === "plugin") {
          await SessionToolContext.plugin()?.markToolSchemaDegraded(item.source.pluginId, item.source.toolId, error)
        }
        const diagnostic = toolSchemaDiagnostic(item, error)
        log.warn("tool skipped due to schema failure", {
          tool: item.id,
          source: item.source,
          executor: ToolExecutor.classify(item.id, item.source),
          sessionID: input.sessionID,
          error: error instanceof Error ? error.message : String(error),
          diagnostic: diagnostic.message,
        })
        result.push({
          id: item.id,
          exposure: item.exposure,
          display: item.display,
          source: item.source,
          executor: ToolExecutor.classify(item.id, item.source),
          diagnostic,
          description: diagnostic.message,
          inputSchema: {
            type: "object",
            additionalProperties: true,
          },
        })
        continue
      }

      result.push({
        id: item.id,
        exposure: item.exposure,
        display: item.display,
        source: item.source,
        executor: ToolExecutor.classify(item.id, item.source),
        description: item.description,
        inputSchema: schema,
        createRuntimeTool(runtimeInput) {
          const context = contextFactory(runtimeInput)
          return tool({
            id: item.id as any,
            description: item.description,
            inputSchema: jsonSchema(schema),
            async execute(args, options) {
              log.info("tool.execute.callback.start", {
                tool: item.id,
                sessionID: runtimeInput.sessionID,
                messageID: runtimeInput.processor.message.id,
                callID: options.toolCallId,
                kind: "builtin",
              })
              const ctx = context(args, options)
              let toolTrace: ToolTrace | undefined
              const slot = runtimeInput.processor.beginExecution(options.toolCallId)
              log.info("tool.execute.callback.slot", {
                tool: item.id,
                sessionID: runtimeInput.sessionID,
                messageID: runtimeInput.processor.message.id,
                callID: options.toolCallId,
                kind: "builtin",
                slotStatus: slot.status,
              })

              try {
                toolTrace = await startToolTrace(runtimeInput, ctx, item.id, args as Record<string, unknown>)
                if (runtimeInput.session) {
                  SessionManager.assertExecutionContext(runtimeInput.session, `tool resolver:${item.id}`)
                }
                const workspace = ScopeContext.current.workspace?.path ?? null
                const workspaceInfo = ScopeContext.current.workspace
                const profileId = await Session.resolveEffectiveControlProfile({
                  sessionID: runtimeInput.session?.id,
                  agentControlProfile: runtimeInput.agent.controlProfile,
                })
                // The bash detached-daemon guard reads ctx.extra.controlProfile; carry the
                // session-effective profile (session > agent config) so full_access sessions
                // bypass the guard as documented (issue #1006).
                ;(ctx.extra as any).controlProfile = profileId
                const synergyRoot = Global.Path.root
                const trustedRoots = await Scope.Root.executionRoots(ScopeContext.current.scope, workspaceInfo)
                const gate = await EnforcementGate.create(
                  await configureGateOptions({
                    activeWorkspace: workspace,
                    workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
                    originalCheckout: (workspaceInfo as any)?.originalCheckout,
                    profileId,
                    readRoots: [synergyRoot, ...trustedRoots, ...SkillSourceProfile.allRootPaths(workspace)],
                    trustedRoots,
                    synergyRoot,
                    sessionKey: runtimeInput.session?.id,
                  }),
                )
                await toolTrace.phase("tool.resolver.ready", "resolver ready", {
                  profileId,
                  workspace,
                  workspaceType: workspaceInfo?.type ?? "scope",
                })

                // Containment is known before authorization: the wrapper is
                // prepared first, its verdict decides the `shell` capability,
                // and a call the sandbox refuses to wrap falls back to the
                // ordinary capability flow instead of being allowed as if it
                // were contained.
                const containment =
                  item.id === "bash"
                    ? prepareShellContainment({
                        gate,
                        ctx,
                        workspace: ScopeContext.current.directory,
                        command: String(args.command ?? ""),
                      })
                    : undefined
                let envelope: ReturnType<Awaited<ReturnType<typeof EnforcementGate.create>>["evaluate"]>
                try {
                  envelope = await gate.evaluateIsolated(
                    item.id,
                    args as Record<string, any>,
                    ctx.abort,
                    containment?.verdict,
                  )
                } finally {
                  // The verdict is already carried by the envelope and the
                  // execution path prepares the wrapper it actually runs, so
                  // release here — on refusal and on success alike — through
                  // the host's existing cleanup contract.
                  containment?.release()
                }
                await RolloutTool.authorize({ stage: "evaluated", profile: gate.getProfileInfo(), envelope })
                const modeDiagnostic = SessionModePolicy.evaluateCall({
                  toolName: item.id,
                  args: args as Record<string, any>,
                  session: runtimeInput.session,
                  capabilities: envelope.capabilities,
                })
                if (modeDiagnostic) throw new ToolDiagnosticError(modeDiagnostic)
                await applyGateApproval(ctx, gate, envelope, item.id, args as Record<string, any>, runtimeInput)
                await RolloutTool.authorize({
                  stage: "authorized",
                  profile: gate.getProfileInfo(),
                  envelope,
                  approval: approvalFromContext(ctx),
                })
                await toolTrace.phase("tool.approval.resolved", "approval resolved", {
                  decision: envelope.decision,
                  capabilities: envelope.capabilities.map((cap) => cap.class),
                })

                const timeoutCfg = await TimeoutConfig.resolve()
                const toolTimeoutMs = timeoutCfg.toolOverrides[item.id] ?? timeoutCfg.toolDefaultMs
                const toolTimeout = ToolTimeout.metadataForTool({
                  tool: item.id,
                  args: args as Record<string, any>,
                  toolTimeoutMs,
                })
                const combinedAbort = startToolTimeout(ctx, toolTimeoutMs)
                ctx.abort = combinedAbort
                await markExecutionStarted(runtimeInput, ctx, args as Record<string, any>, toolTimeout)
                await toolTrace.phase("tool.execution.started", "execution started", {
                  timeoutMs: toolTimeoutMs,
                })
                const toolCtx = { ...ctx, abort: combinedAbort }
                using toolTimer = log.time("tool.execute", { tool: item.id, callID: options.toolCallId })

                // ── Sandbox wrapping for bash ──────────────────────────
                if (item.id === "bash") {
                  const sandbox = gate.getSandbox()
                  if (sandbox.mode !== "none" && !shouldBypassShellSandbox(ctx)) {
                    // Register externally-approved roots, plus the paths the
                    // user approved for this session after a sandbox denial,
                    // so the policy engine aggregates them with auto-approved
                    // paths and a retry finds them inside the sandbox roots.
                    const sessionKey = runtimeInput.session?.id ?? ctx.sessionID
                    const sessionReads = SandboxSessionApproval.readPaths(sessionKey)
                    const sessionWrites = SandboxSessionApproval.writePaths(sessionKey)
                    const extRoots = [...new Set([...approvedExternalRoots(ctx), ...sessionReads])]
                    if (extRoots.length > 0 || sessionWrites.length > 0) {
                      gate.registerApprovedPaths(extRoots, [...new Set([...extRoots, ...sessionWrites])], false)
                    }
                    const sandboxPolicy = gate.getSandboxPolicy()
                    const sandboxPrepare: BashSandboxPrepare = async (input) => {
                      await toolTrace?.phase("tool.sandbox.prepare", "sandbox prepare", {
                        mode: sandbox.mode,
                        backend: sandbox.backend,
                        fallback: sandbox.fallback,
                      })
                      const wrapper = SandboxHost.prepareWrapper({
                        command: "/bin/sh",
                        args: ["-c", input.command],
                        workspace: ScopeContext.current.directory,
                        sandboxMode: sandbox.mode,
                        extraReadRoots: [
                          ...new Set([
                            ...(sandboxPolicy?.fileSystem.readableRoots ?? []),
                            synergyRoot,
                            ...trustedRoots,
                            ...extRoots,
                            ...input.extraReadRoots,
                          ]),
                        ],
                        extraWritableRoots: sandboxPolicy?.fileSystem.writableRoots ?? [],
                        protectedPaths: sandboxPolicy?.fileSystem.protectedPaths,
                        dataDenyRoots: sandboxPolicy?.fileSystem.dataDenyRoots,
                        stripDefaultHomeDenyRoot: true,
                        networkMode: sandboxPolicy?.network.mode,
                        backend: sandbox.backend,
                      })
                      if (wrapper.skipReason && sandbox.fallback !== "deny") {
                        log.warn("sandbox.unavailable", { skipReason: wrapper.skipReason })
                      }
                      await toolTrace?.phase("tool.sandbox.prepared", "sandbox prepared", {
                        skipReason: wrapper.skipReason,
                        command: wrapper.command,
                        args: wrapper.args,
                      })
                      return wrapper
                    }
                    ;(toolCtx.extra as any).sandboxPrepare = sandboxPrepare
                    ;(toolCtx.extra as any).sandboxFallback = sandbox.fallback
                  }
                }

                // ── Plugin: tool.execute.before ────────────────────────
                await toolTrace.phase("plugin.runtime.before.start", "plugin before start")
                await triggerToolHook(
                  "tool.execute.before",
                  {
                    tool: item.id,
                    sessionID: ctx.sessionID,
                    callID: ctx.callID,
                  },
                  {
                    args,
                  },
                  combinedAbort,
                )
                await toolTrace.phase("plugin.runtime.before.end", "plugin before end")
                await toolTrace.phase("tool.execute.start", "tool execute start")
                // Secret boundary: tokens resolve into an execution-only args
                // copy (the durable args stay tokenized), the bash secret
                // environment rides toolCtx.extra, and the settled result is
                // masked before rollout capture, plugins, and persistence.
                const secrets = await SecretResolve.transformArgs(args, {
                  sessionID: ctx.sessionID,
                  tool: item.id,
                })
                if (secrets.secretEnv) (toolCtx.extra ??= {}).secretEnv = secrets.secretEnv
                const executed = await settleExecutionOnAbort(() => item.execute(secrets.args, toolCtx), combinedAbort)
                const result = (await SecretMask.transformResult(executed, combinedAbort)) as typeof executed
                Tool.validateAttachmentResult(item.id, result)
                await RolloutTool.capture(result)
                await toolTrace.phase("tool.execute.end", "tool execute end", {
                  outputChars: result.output.length,
                  attachmentCount: result.attachments?.length ?? 0,
                })
                await toolTrace.phase("plugin.runtime.after.start", "plugin after start")
                await triggerToolHook(
                  "tool.execute.after",
                  {
                    tool: item.id,
                    sessionID: ctx.sessionID,
                    callID: ctx.callID,
                  },
                  result,
                  combinedAbort,
                )
                await toolTrace.phase("plugin.runtime.after.end", "plugin after end")
                RolloutTool.afterCommit(() =>
                  slot.complete(args, {
                    output: result.output,
                    title: result.title ?? "",
                    metadata: approvalFromContext(ctx)
                      ? { approval: approvalFromContext(ctx), ...(result.metadata ?? {}) }
                      : (result.metadata ?? {}),
                    attachments: result.attachments,
                    afterPersist: item.afterPersist ? () => item.afterPersist!(args, toolCtx, result) : undefined,
                  }),
                )
                log.info("tool.execute.callback.completed", {
                  tool: item.id,
                  sessionID: ctx.sessionID,
                  messageID: runtimeInput.processor.message.id,
                  callID: options.toolCallId,
                  kind: "builtin",
                  slotStatus: slot.status,
                })
                await toolTrace.end({
                  outputChars: result.output.length,
                  attachmentCount: result.attachments?.length ?? 0,
                })
                return result
              } catch (error) {
                if (error instanceof EnforcementError.SandboxBlocked) {
                  await requestSandboxDenialApproval(error, ctx, runtimeInput)
                  await setApprovalMetadata(ctx, {
                    status: "sandbox_blocked",
                    source: "sandbox",
                    reason: error.message,
                  })
                }
                log.error("tool.execute.error", {
                  tool: item.id,
                  sessionID: ctx.sessionID,
                  callID: options.toolCallId,
                  error,
                })
                ObservabilityToolFailures.raiseIssue({
                  tool: item.id,
                  sessionID: runtimeInput.sessionID,
                  messageID: runtimeInput.processor.message.id,
                  callID: options.toolCallId,
                  traceId: toolTrace?.traceId,
                  spanId: toolTrace?.span?.spanId,
                  scopeID: toolTrace?.span?.scopeID,
                  phase: "tool.execute",
                  error,
                  owner: "builtin",
                })
                RolloutTool.afterCommit(() =>
                  slot.fail(args, formatErrorForModel(error, ctx), metadataForError(error, approvalFromContext(ctx))),
                )
                log.warn("tool.execute.callback.failed", {
                  tool: item.id,
                  sessionID: ctx.sessionID,
                  messageID: runtimeInput.processor.message.id,
                  callID: options.toolCallId,
                  kind: "builtin",
                  slotStatus: slot.status,
                })
                await toolTrace?.error(error)
                throw error
              } finally {
                toolTrace?.dispose()
                disposeToolTimeout(ctx)
              }
            },
            toModelOutput(result) {
              return {
                type: "text",
                value: result.output,
              }
            },
          })
        },
      })
    }

    if (input.includeMCP !== false) {
      const mcpSource = ToolMcpSource.get()
      const mcpExposure = await mcpSource?.exposureConfiguration()
      const mcpEntries = mcpSource ? await mcpSource.toolEntries() : []
      const mcpToolNames = new Set(mcpEntries.map((entry) => entry.id))
      for (const entry of mcpEntries) {
        const key = entry.id
        const item = entry.tool
        const exposure = ToolExposure.mcpExposure(
          entry.serverName,
          mcpExposure?.expandByDefault(entry.serverName) ?? false,
        )
        const schema = entry.inputSchema
        result.push({
          id: key,
          exposure,
          description: item.description ?? "",
          inputSchema: schema,
          executor: "mcp",
          createRuntimeTool(runtimeInput) {
            const context = contextFactory(runtimeInput)
            const execute = item.execute
            if (!execute) return item
            return {
              ...item,
              execute: async (args, opts) => {
                log.info("tool.execute.callback.start", {
                  tool: key,
                  sessionID: runtimeInput.sessionID,
                  messageID: runtimeInput.processor.message.id,
                  callID: opts.toolCallId,
                  kind: "mcp",
                })
                const ctx = context(args, opts)
                let toolTrace: ToolTrace | undefined
                const slot = runtimeInput.processor.beginExecution(opts.toolCallId)
                log.info("tool.execute.callback.slot", {
                  tool: key,
                  sessionID: runtimeInput.sessionID,
                  messageID: runtimeInput.processor.message.id,
                  callID: opts.toolCallId,
                  kind: "mcp",
                  slotStatus: slot.status,
                })

                try {
                  toolTrace = await startToolTrace(runtimeInput, ctx, key, args as Record<string, unknown>)
                  if (runtimeInput.session) {
                    SessionManager.assertExecutionContext(runtimeInput.session, `tool resolver:${key}`)
                  }
                  const workspace = ScopeContext.current.workspace?.path ?? null
                  const workspaceInfo = ScopeContext.current.workspace
                  const profileId = await Session.resolveEffectiveControlProfile({
                    sessionID: runtimeInput.session?.id,
                    agentControlProfile: runtimeInput.agent.controlProfile,
                  })
                  // Same effective-profile carry as the builtin path (issue #1006).
                  ;(ctx.extra as any).controlProfile = profileId
                  const trustedRoots = await Scope.Root.executionRoots(ScopeContext.current.scope, workspaceInfo)
                  const gate = await EnforcementGate.create(
                    await configureGateOptions({
                      activeWorkspace: workspace,
                      workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
                      originalCheckout: (workspaceInfo as any)?.originalCheckout,
                      registeredMcpTools: mcpToolNames,
                      profileId,
                      readRoots: [Global.Path.root, ...trustedRoots, ...SkillSourceProfile.allRootPaths(workspace)],
                      synergyRoot: Global.Path.root,
                      trustedRoots,
                      sessionKey: runtimeInput.session?.id,
                    }),
                  )
                  await toolTrace.phase("tool.resolver.ready", "resolver ready", {
                    profileId,
                    workspace,
                    workspaceType: workspaceInfo?.type ?? "scope",
                  })
                  const envelope = await gate.evaluateIsolated(key, args as Record<string, any>, ctx.abort)
                  await RolloutTool.authorize({ stage: "evaluated", profile: gate.getProfileInfo(), envelope })
                  const modeDiagnostic = SessionModePolicy.evaluateCall({
                    toolName: key,
                    args: args as Record<string, any>,
                    session: runtimeInput.session,
                    capabilities: envelope.capabilities,
                  })
                  if (modeDiagnostic) throw new ToolDiagnosticError(modeDiagnostic)
                  await applyGateApproval(ctx, gate, envelope, key, args as Record<string, any>, runtimeInput)
                  await RolloutTool.authorize({
                    stage: "authorized",
                    profile: gate.getProfileInfo(),
                    envelope,
                    approval: approvalFromContext(ctx),
                  })
                  await toolTrace.phase("tool.approval.resolved", "approval resolved", {
                    decision: envelope.decision,
                    capabilities: envelope.capabilities.map((cap) => cap.class),
                  })

                  const timeoutCfg = await TimeoutConfig.resolve()
                  const toolTimeoutMs = timeoutCfg.toolOverrides[key] ?? timeoutCfg.toolDefaultMs
                  const toolTimeout = ToolTimeout.metadataForTool({
                    tool: key,
                    args: args as Record<string, any>,
                    toolTimeoutMs,
                    mcpCallTimeoutMs: ToolMcpSource.get()?.toolCallTimeout(key),
                  })
                  const combinedAbort = startToolTimeout(ctx, toolTimeoutMs)
                  ctx.abort = combinedAbort
                  await markExecutionStarted(runtimeInput, ctx, args as Record<string, any>, toolTimeout)
                  await toolTrace.phase("tool.execution.started", "execution started", {
                    timeoutMs: toolTimeoutMs,
                  })
                  using toolTimer = log.time("tool.execute", { tool: key, callID: opts.toolCallId })

                  await toolTrace.phase("plugin.runtime.before.start", "plugin before start")
                  await triggerToolHook(
                    "tool.execute.before",
                    {
                      tool: key,
                      sessionID: ctx.sessionID,
                      callID: opts.toolCallId,
                    },
                    {
                      args,
                    },
                    combinedAbort,
                  )
                  await toolTrace.phase("plugin.runtime.before.end", "plugin before end")

                  await toolTrace.phase("tool.execute.start", "tool execute start")
                  // Secret boundary, same ordering as the builtin path:
                  // resolve into an execution-only args copy and mask the raw
                  // result before rollout capture so artifacts stay tokenized.
                  const mcpSecrets = await SecretResolve.transformArgs(args as Record<string, any>, {
                    sessionID: ctx.sessionID,
                    tool: key,
                  })
                  const rawResult = await settleExecutionOnAbort(
                    () => execute(mcpSecrets.args as Record<string, any>, { ...opts, abortSignal: combinedAbort }),
                    combinedAbort,
                  )
                  await SecretMask.transformResult(rawResult as Record<string, any>, combinedAbort)
                  await RolloutTool.capture(rawResult)
                  let result = ToolMcpSource.get()!.normalizeResult(rawResult)
                  await toolTrace.phase("tool.execute.end", "tool execute end", {
                    contentCount: result.content.length,
                  })

                  await toolTrace.phase("plugin.runtime.after.start", "plugin after start")
                  await triggerToolHook(
                    "tool.execute.after",
                    {
                      tool: key,
                      sessionID: ctx.sessionID,
                      callID: opts.toolCallId,
                    },
                    rawResult,
                    combinedAbort,
                  )
                  await toolTrace.phase("plugin.runtime.after.end", "plugin after end")

                  result = ToolMcpSource.get()!.normalizeResult(rawResult)
                  const attachments: MessageV2.AttachmentPart[] = []

                  for (const contentItem of result.images) {
                    attachments.push({
                      id: Identifier.ascending("part"),
                      sessionID: runtimeInput.sessionID,
                      messageID: runtimeInput.processor.message.id,
                      type: "attachment",
                      mime: contentItem.mimeType,
                      url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
                      presentation: { renderer: "image", size: "medium", crop: false },
                      model: {
                        mode: "provider-file",
                        summary: `${contentItem.mimeType} image returned by ${key}`,
                      },
                    })
                  }

                  const output = {
                    title: "",
                    metadata: result.metadata ?? {},
                    output: result.text,
                    attachments,
                    content: result.content,
                  }
                  Tool.validateAttachmentResult(key, output)

                  RolloutTool.afterCommit(() =>
                    slot.complete(args, {
                      output: output.output,
                      title: output.title,
                      metadata: approvalFromContext(ctx)
                        ? { approval: approvalFromContext(ctx), ...output.metadata }
                        : output.metadata,
                      attachments: output.attachments,
                    }),
                  )
                  log.info("tool.execute.callback.completed", {
                    tool: key,
                    sessionID: ctx.sessionID,
                    messageID: runtimeInput.processor.message.id,
                    callID: opts.toolCallId,
                    kind: "mcp",
                    slotStatus: slot.status,
                  })

                  await toolTrace.end({
                    outputChars: output.output.length,
                    attachmentCount: output.attachments.length,
                    contentCount: output.content.length,
                  })
                  return output
                } catch (error) {
                  if (error instanceof EnforcementError.SandboxBlocked) {
                    await setApprovalMetadata(ctx, {
                      status: "sandbox_blocked",
                      source: "sandbox",
                      reason: error.message,
                    })
                  }
                  log.error("tool.execute.error", {
                    tool: key,
                    sessionID: ctx.sessionID,
                    callID: opts.toolCallId,
                    error,
                  })
                  ObservabilityToolFailures.raiseIssue({
                    tool: key,
                    sessionID: runtimeInput.sessionID,
                    messageID: runtimeInput.processor.message.id,
                    callID: opts.toolCallId,
                    traceId: toolTrace?.traceId,
                    spanId: toolTrace?.span?.spanId,
                    scopeID: toolTrace?.span?.scopeID,
                    phase: "tool.execute",
                    error,
                    owner: "mcp",
                  })
                  RolloutTool.afterCommit(() =>
                    slot.fail(args, formatErrorForModel(error, ctx), metadataForError(error, approvalFromContext(ctx))),
                  )
                  log.warn("tool.execute.callback.failed", {
                    tool: key,
                    sessionID: ctx.sessionID,
                    messageID: runtimeInput.processor.message.id,
                    callID: opts.toolCallId,
                    kind: "mcp",
                    slotStatus: slot.status,
                  })
                  await toolTrace?.error(error)
                  throw error
                } finally {
                  toolTrace?.dispose()
                  disposeToolTimeout(ctx)
                }
              },
              toModelOutput(result) {
                return {
                  type: "text",
                  value: result.output,
                }
              },
            }
          },
        })
      }
    }

    return result
  }

  export async function availability(input: Omit<Input, "processor">): Promise<Availability> {
    using _ = log.time("availability")
    return await applyAvailability(await collectDefinitions(input), input)
  }

  export async function definitions(input: Omit<Input, "processor">): Promise<Definition[]> {
    return (await availability(input)).visible
  }

  function withExecutionDeduplication(input: Input, runtimeTool: AITool, toolName: string): AITool {
    const execute = runtimeTool.execute
    if (!execute) return runtimeTool
    return {
      ...runtimeTool,
      execute(args, options) {
        return input.processor.executeOnce(options.toolCallId, () => {
          const toolInput = SessionToolInput.normalize(args)
          if (SessionBounds.toolInputByteLength(toolInput) > SessionBounds.TOOL_INPUT_MAX_BYTES) {
            const error = SessionBounds.toolInputExceededMessage()
            input.processor.beginExecution(options.toolCallId).fail({}, error)
            throw new Error(error)
          }
          return RolloutTool.execute(
            {
              owner: { kind: "session", scopeID: ScopeContext.current.scope.id, sessionID: input.sessionID },
              runID: input.processor.message.rootID ?? input.processor.message.parentID,
              messageID: input.processor.message.id,
              toolCallID: options.toolCallId,
              tool: toolName,
              args: JSON.parse(JSON.stringify(toolInput)),
            },
            async () => execute.call(runtimeTool, args, options),
            () => {
              SessionManager.signalAbort(input.sessionID, {
                rootID: input.processor.message.rootID ?? input.processor.message.parentID,
              })
            },
          )
        })
      },
    } as AITool
  }

  /**
   * Resolve execution tools from an availability result. Callers that already
   * hold one for this round (the turn loop resolves definitions while it
   * assembles the prompt) pass it as `prepared` so the registry, MCP, and
   * ephemeral sources are collected once per round instead of twice. The
   * `availability` and `resolveWithAvailability` timing spans stay in place:
   * the caller still measures collection, and this function still measures
   * resolution.
   */
  export async function resolveWithAvailability(input: Input, prepared?: Availability): Promise<ResolvedTools> {
    using _ = log.time("resolveWithAvailability")
    const executionTools: Record<string, AITool> = {}
    const executorKinds: Record<string, ToolExecutorKind> = {}
    const availabilityResult = prepared ?? (await availability(input))
    const activeToolIDs = availabilityResult.visible.map((item) => item.id)
    const runtimeInput = { ...input, activeToolIDs }

    for (const item of availabilityResult.visible) {
      const runtimeTool = item.createRuntimeTool?.(runtimeInput)
      if (runtimeTool) {
        executionTools[item.id] = withExecutionDeduplication(runtimeInput, runtimeTool, item.id)
        executorKinds[item.id] = item.executor ?? ToolExecutor.classify(item.id, item.source)
      }
    }

    for (const diagnostic of availabilityResult.diagnostics.values()) {
      if (executionTools[diagnostic.toolName]) continue
      executionTools[diagnostic.toolName] = withExecutionDeduplication(
        runtimeInput,
        diagnosticRuntimeTool(runtimeInput, diagnostic),
        diagnostic.toolName,
      )
      executorKinds[diagnostic.toolName] =
        availabilityResult.visible.find((item) => item.id === diagnostic.toolName)?.executor ?? "control_plane"
    }

    return {
      definitions: availabilityResult.visible.map(({ id, description, inputSchema }) => ({
        id,
        description,
        inputSchema,
      })),
      executionTools,
      executorKinds,
      activeToolIDs,
      autoExpandable: availabilityResult.autoExpandable,
    }
  }

  export interface AutoExpandedTool {
    tool: AITool
    executor: ToolExecutorKind
    inputSchema?: JSONSchema7
    group?: string
    activatedTool?: string
  }

  /**
   * Validate model-supplied arguments against the real tool schema before an
   * auto-expanded call is dispatched. Deferred tools are absent from
   * toolDefinitions (the diagnostic stub carries an open schema), so the AI SDK
   * never validated the arguments; MCP and plugin execution paths do not
   * revalidate. Returns an invalid-arguments message, or undefined when the
   * input satisfies the schema or the schema cannot be compiled.
   */
  export function validateToolInput(
    toolName: string,
    schema: JSONSchema7 | undefined,
    input: unknown,
  ): string | undefined {
    if (!schema) return undefined
    try {
      const ajv = new Ajv2020({ allErrors: true, strict: false })
      const validate = ajv.compile(schema as any)
      if (validate(input)) return undefined
      return `The ${toolName} tool was called with invalid arguments: ${ajv.errorsText(validate.errors)}.\nPlease rewrite the input so it satisfies the expected schema.`
    } catch {
      // Uncompilable schemas (e.g. unsupported draft) fall back to the previous
      // behavior; execution paths with their own validation still apply.
      return undefined
    }
  }

  /**
   * Resolve the runtime tool for a single tool name against a fresh session
   * snapshot. Returns undefined when the tool is not visible under the current
   * permission, user-tool, or mode policy — fail closed.
   */
  export async function runtimeToolFor(
    input: Input,
    toolName: string,
  ): Promise<{ tool: AITool; executor: ToolExecutorKind; inputSchema?: JSONSchema7 } | undefined> {
    using _ = log.time("runtimeToolFor")
    const session = input.session ?? (await Session.get(input.sessionID).catch(() => undefined))
    const availabilityResult = await applyAvailability(await collectDefinitions({ ...input, session }), {
      ...input,
      session,
    })
    const item = availabilityResult.visible.find((def) => def.id === toolName)
    if (!item) return undefined
    const runtimeInput = { ...input, session, activeToolIDs: availabilityResult.visible.map((def) => def.id) }
    const runtimeTool = item.createRuntimeTool?.(runtimeInput)
    if (!runtimeTool) return undefined
    return {
      tool: withExecutionDeduplication(runtimeInput, runtimeTool, item.id),
      executor: item.executor ?? ToolExecutor.classify(item.id, item.source),
      inputSchema: item.inputSchema,
    }
  }

  /**
   * Persist the expansion for a single deferred tool (group or activation)
   * through the canonical session toolState, then resolve its runtime tool
   * against the fresh session. Returns undefined when the tool does not exist
   * or remains hidden after expansion — fail closed.
   */
  export async function autoExpandTool(input: Input, toolName: string): Promise<AutoExpandedTool | undefined> {
    using _ = log.time("autoExpandTool")
    const session = await Session.get(input.sessionID).catch(() => undefined)
    if (!session) return undefined
    const { ToolDiscovery } = await import("../tool/discovery")
    const catalog = await ToolDiscovery.collect({
      providerID: ToolDiscovery.providerIDFromModel(input.model),
      agent: input.agent,
      session,
      userTools: input.userTools,
      includeMCP: input.includeMCP,
    })
    const entry = catalog.tools.find((tool) => tool.id === toolName)
    if (!entry) return undefined
    if (catalog.disabled.has(toolName)) return undefined
    if (catalog.disabled.has("expand_tools") || !ToolExposure.userAllows("expand_tools", input.userTools)) {
      return undefined
    }
    const expansion = ToolExposure.expansionForTool(toolName, entry.exposure, session.toolState)
    if (expansion.kind === "none") {
      return (await runtimeToolFor({ ...input, session }, toolName)) ?? undefined
    }
    // Merge into the draft inside the mutation lock: the pre-lock snapshot can
    // be stale when concurrent auto-expansions run in the same turn, and
    // overwriting toolState wholesale would drop the other expansion.
    await Session.update(session.id, (draft) => {
      draft.toolState = ToolExposure.expandState(
        draft.toolState,
        expansion.kind === "group" ? [expansion.group] : undefined,
        expansion.kind === "activate" ? [expansion.tool] : undefined,
      )
    })
    // Re-fetch the session so the fresh toolState is visible to the
    // availability re-check; the pre-update snapshot would still hide the tool.
    const freshSession = await Session.get(input.sessionID).catch(() => undefined)
    if (!freshSession) return undefined
    const resolved = await runtimeToolFor({ ...input, session: freshSession }, toolName)
    if (!resolved) return undefined
    return {
      ...resolved,
      ...(expansion.kind === "group" ? { group: expansion.group } : { activatedTool: expansion.tool }),
    }
  }

  export async function resolve(input: Input): Promise<Record<string, AITool>> {
    using _ = log.time("resolve")
    const tools: Record<string, AITool> = {}
    const defs = await definitions(input)
    const activeToolIDs = defs.map((item) => item.id)
    const runtimeInput = { ...input, activeToolIDs }

    for (const item of defs) {
      const runtimeTool = item.createRuntimeTool?.(runtimeInput)
      if (runtimeTool) tools[item.id] = withExecutionDeduplication(runtimeInput, runtimeTool, item.id)
    }

    return tools
  }
}
