import { Global } from "@/global"
import { type Tool as AITool, tool, jsonSchema, type ToolCallOptions, type JSONSchema7 } from "ai"
import z from "zod"
import { Agent } from "@/agent/agent"
import { Identifier } from "@/id/id"
import { MCP } from "@/mcp"
import { PermissionNext } from "@/permission/next"
import { PermissionRules } from "@/permission/rules"
import { SmartAllow } from "@/permission/smart-allow"
import { Plugin } from "@/plugin"
import { PluginToolId } from "../plugin/ids.js"
import { toolCapabilities, toolRisk } from "../plugin/capability"
import { getApproval, type PluginApprovalRecord } from "../plugin/consent/approval-store"
import { markContributionDegraded } from "../plugin/loader"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { ToolTimeout } from "@/tool/timeout"
import { ToolExposure } from "@/tool/exposure"
import type { ToolDisplay } from "@ericsanchezok/synergy-plugin/tool"
import { Log } from "@/util/log"
import { TimeoutConfig } from "@/util/timeout-config"
import { Session } from "."
import { SessionManager } from "./manager"
import type { Info } from "./types"
import { MessageV2 } from "./message-v2"
import type { SessionProcessor } from "./processor"
import { ScopeContext } from "@/scope/context"
import { EnforcementGate, type Capability } from "@/enforcement/gate"
import { SandboxBackend } from "@/sandbox/backend"
import type { BashSandboxPrepare } from "@/tool/bash/shared"
import type { ResolvedProfile } from "@/control-profile/types"
import { EnforcementError } from "@/enforcement/errors"
import { Config } from "@/config/config"
import { ControlProfileCompiler } from "@/control-profile/compiler"
import { ApprovalPolicy, type ApprovalMetadata } from "@/control-profile/approval"
import { Observability } from "@/observability"
import { SessionModePolicy } from "./tool-mode-policy"
import { ToolDiagnostic, ToolDiagnosticError, type ToolDiagnostic as ToolDiagnosticInfo } from "@/tool/diagnostic"
import { ObservabilityIssues } from "@/observability/issues"
import { ObservabilityToolFailures } from "@/observability/tool-failures"
import { ObservabilityMetrics } from "@/observability/metrics"
import { ObservabilityRedaction } from "@/observability/redaction"
import { ObservabilitySpans } from "@/observability/spans"
import { SkillPaths } from "@/skill/paths"
import { LightLoopReviewAccess } from "./light-loop-review-access"
import { BlueprintLoopReviewAccess } from "./blueprint-loop-review-access"
import { BlueprintLoopStore } from "@/blueprint"

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
    cwd: string
    scopeID: string
  }

  const activeTraces = new Map<string, ActiveTraceEntry>()
  const SWEEP_INTERVAL_MS = 5_000
  let sweepTimer: ReturnType<typeof setInterval> | null = null

  function ensureSweepTimer() {
    if (sweepTimer) return
    sweepTimer = setInterval(() => sweepActiveTraces(), SWEEP_INTERVAL_MS)
    if (typeof sweepTimer === "object" && "unref" in sweepTimer) sweepTimer.unref()
  }

  export function sweepActiveTraces(now = Date.now()) {
    if (activeTraces.size === 0) {
      stopSweepTimer()
      return
    }
    for (const entry of activeTraces.values()) {
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
    if (!sweepTimer) return
    clearInterval(sweepTimer)
    sweepTimer = null
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
  }

  export interface ResolvedTools {
    tools: Record<string, AITool>
    activeToolIDs: string[]
  }

  interface PluginGateData {
    toolCapabilities: Record<string, { capabilities: string[]; risk: "low" | "medium" | "high" }>
    approvals: Record<string, PluginApprovalRecord>
  }

  async function currentPluginToolIds(): Promise<Set<string>> {
    const ids = new Set<string>()
    for (const plugin of await Plugin.getLoaded()) {
      for (const contribution of plugin.manifest.contributions) {
        if (contribution.kind === "tool") ids.add(PluginToolId.format(plugin.id, contribution.id))
      }
    }
    return ids
  }

  async function currentPluginGateData(): Promise<PluginGateData> {
    const caps: Record<string, { capabilities: string[]; risk: "low" | "medium" | "high" }> = {}
    const approvals: Record<string, PluginApprovalRecord> = {}
    for (const plugin of await Plugin.getLoaded()) {
      try {
        const manifest = plugin.manifest
        for (const contribution of manifest.contributions) {
          if (contribution.kind !== "tool") continue
          const capabilities = toolCapabilities(manifest, contribution.id)
          caps[PluginToolId.format(plugin.id, contribution.id)] = {
            capabilities,
            risk: toolRisk(manifest, contribution.id),
          }
        }
        const approval = await getApproval(plugin.id, manifest)
        if (approval) approvals[plugin.id] = approval
      } catch (err) {
        log.warn("plugin gate data skipped", {
          pluginId: plugin.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return { toolCapabilities: caps, approvals }
  }

  /**
   * Derive an external path string from tool args for use in nonBypassable
   * permission asks triggered by the enforcement gate.
   */
  function externalPathFromArgs(toolName: string, args: Record<string, any>): string {
    if (toolName === "bash") return (args.workdir ?? args.command) as string
    //     if (toolName === "agora_join" || toolName === "agora_accept") return (args.directory ?? "") as string
    if (toolName === "look_at" || toolName === "view_image" || toolName === "attach") {
      const raw = args.file_path ?? args.filePath ?? ""
      return Array.isArray(raw) ? (raw[0] ?? "") : String(raw)
    }
    return (args.filePath ?? args.path ?? args.pattern ?? "") as string
  }

  function permissionForGateCapability(toolName: string, className: string): string {
    if (className === "file_external_read" || className === "file_external_write") return "external_directory"
    if (className === "shell_read" || className === "shell_remote_publish" || className === "shell_remote_write")
      return "bash"
    if (className === "shell_destructive") return "bash"
    if (className === "network_request")
      return toolName === "webfetch" || toolName === "websearch" ? toolName : "network_request"
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

  function rememberShellApproval(ctx: Tool.Context, permission: string, metadata: Record<string, unknown>) {
    const capability = String(metadata.capability ?? "")
    if (
      permission === "bash" ||
      capability === "shell" ||
      capability === "shell_read" ||
      capability === "shell_remote_publish" ||
      capability === "shell_remote_write" ||
      capability === "shell_destructive"
    ) {
      markShellSandboxBypass(ctx)
    }
  }

  function rememberApprovedExternalRoots(ctx: Tool.Context, patterns: string[]) {
    const roots = patterns.filter((pattern) => pattern.startsWith("/"))
    if (roots.length === 0) return
    ;(ctx.extra as any).approvedExternalRoots = [...new Set([...approvedExternalRoots(ctx), ...roots])]
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
    const startedAt = Date.now()
    let phase = "start"
    let lastActivity = startedAt
    const stalledMs = await stalledToolMs()
    const scopeID = ScopeContext.current.scope.id
    const cwd = ObservabilityRedaction.cwdScope(ScopeContext.current.directory)
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
    activeTraces.set(activeTraceKey, entry)
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
        activeTraces.delete(activeTraceKey)
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
    const match = input.processor.partFromToolCall(ctx.callID)
    if (!match || match.state.status !== "running") return

    const updated = await Session.updatePart({
      ...match,
      state: {
        ...match.state,
        title: state.title ?? match.state.title,
        metadata: ToolTimeout.mergeMetadata(match.state.metadata, state.metadata) ?? match.state.metadata,
        status: "running",
        input: args,
        time: {
          start: state.start ?? match.state.time.start,
        },
      },
    })
    Object.assign(match, updated)
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

    const match = ctx.callID ? input.processor.partFromToolCall(ctx.callID) : undefined
    const metadata = {
      ...(match?.state.status === "running" ? (match.state.metadata ?? {}) : {}),
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
    const timer = setTimeout(() => timeout.abort(), timeoutMs)
    if (typeof timer === "object" && "unref" in timer) timer.unref()
    timing.toolTimeoutCleanup = () => {
      clearTimeout(timer)
      timing.toolTimeoutCleanup = undefined
    }
    return AbortSignal.any([timing.sessionAbort, timeout.signal])
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

    if (profile.profileId === "full_access" && decision.action !== "allow") {
      await setApprovalMetadata(
        ctx,
        ApprovalPolicy.metadata(approval, { ...decision, action: "allow" }, "auto_allowed"),
      )
      if (toolName === "bash") markShellSandboxBypass(ctx)
      return
    }

    // Profile already permits the operation — no need for Smart allow.
    if (decision.action === "allow") {
      await setApprovalMetadata(ctx, ApprovalPolicy.metadata(approval, decision, "auto_allowed"))
      if (toolName === "bash") markShellSandboxBypass(ctx)
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
        if (toolName === "bash") markShellSandboxBypass(ctx)
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
          tool: toolName,
          args,
          capabilities: envelope.capabilities.map((c) => c.class),
          workspace: ScopeContext.current.directory,
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
          if (toolName === "bash") markShellSandboxBypass(ctx)
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
      throw new EnforcementError.PolicyDenied(diagnosticReason, decision.capabilities, envelope.profileId)
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
      throw new EnforcementError.PolicyDenied(diagnosticReason, decision.capabilities, envelope.profileId)
    }

    // Provenance: sessions created by system scheduling (e.g. agenda wake)
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
      if (toolName === "bash") markShellSandboxBypass(ctx)
      return
    }

    const gateOwnedAsks = envelope.capabilities.filter((cap) => {
      if (!cap.nonBypassable && !cap.opaque) return false
      if (!gate.hasPendingCapability(cap.class)) return false
      // These tools already perform the exact same non-bypassable ask with
      // richer, tool-specific metadata before crossing the boundary.
      if (toolName === "email_send" && cap.class === "communication_email") return false
      if (toolName === "session_send" && cap.class === "identity_act") return false
      if ((toolName === "webfetch" || toolName === "websearch") && cap.class === "network_request") return false
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

  function formatErrorForModel(error: unknown): string {
    if (error instanceof ToolDiagnosticError) {
      return error.message
    }

    if (error instanceof EnforcementError.PolicyDenied) {
      return [
        `Permission denied by profile "${error.profileId}".`,
        `Blocked capabilities: ${error.capabilities.join(", ")}`,
        `This is a policy restriction. Do not retry the same approach.`,
        error.message,
      ].join("\n")
    }

    if (error instanceof EnforcementError.SandboxBlocked) {
      return error.message
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
      let profilePromise: Promise<ResolvedProfile> | undefined
      const resolvedProfile = async (): Promise<ResolvedProfile> => {
        if (!profilePromise) {
          profilePromise = (async () => {
            const profileId = await Session.resolveEffectiveControlProfile({
              sessionID: input.session?.id,
              agentControlProfile: input.agent.controlProfile,
            })
            const workspaceInfo = ScopeContext.current.workspace
            return ControlProfileCompiler.resolve(profileId, {
              workspace: ScopeContext.current.directory,
              workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
            })
          })()
        }
        return profilePromise
      }
      const match = input.processor.partFromToolCall(options.toolCallId)
      const sessionAbort = options.abortSignal ?? neverAbort
      const ctx: Tool.Context = {
        sessionID: input.sessionID,
        abort: sessionAbort,
        messageID: input.processor.message.id,
        callID: options.toolCallId,
        extra: {
          model: input.model,
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

  function forcedToolGroups(session?: Info) {
    const result = new Set<string>()
    if (session?.workflow?.kind === "plan" || session?.workflow?.kind === "lattice" || session?.blueprint?.loopID) {
      result.add("note")
    }
    if (session?.interaction?.source === "chronicler") {
      result.add("memory")
    }
    return result
  }

  function forcedTools(userTools?: Record<string, boolean>) {
    return Object.entries(userTools ?? {})
      .filter(([id, enabled]) => id !== "*" && enabled === true)
      .map(([id]) => id)
  }

  function userToolAllows(toolID: string, userTools?: Record<string, boolean>) {
    if (!userTools) return true
    if (userTools[toolID] === true) return true
    if (userTools[toolID] === false) return false
    if (userTools["*"] === false) return false
    return true
  }

  async function isRecordedLightLoopReviewSession(input: Omit<Input, "processor">): Promise<boolean> {
    if (!input.session?.id) return false
    return (
      (await LightLoopReviewAccess.resolve({
        agent: input.agent.name,
        reviewSessionID: input.session.id,
        reviewSession: input.session,
      })) !== undefined
    )
  }

  async function isRecordedBlueprintLoopReviewSession(input: Omit<Input, "processor">): Promise<boolean> {
    if (!input.session?.id) return false
    return (
      (await BlueprintLoopReviewAccess.resolve({
        agent: input.agent.name,
        reviewSessionID: input.session.id,
        reviewSession: input.session,
      })) !== undefined
    )
  }

  async function canStopBlueprintLoop(input: Omit<Input, "processor">): Promise<boolean> {
    const session = input.session
    if (!session?.id || session.blueprint?.loopRole !== "execution" || !session.blueprint.loopID) return false
    const loop = await BlueprintLoopStore.get(session.scope.id, session.blueprint.loopID).catch(() => undefined)
    return loop?.status === "running" && loop.sessionID === session.id
  }

  async function applyAvailability(defs: Definition[], input: Omit<Input, "processor">): Promise<Availability> {
    const visible: Definition[] = []
    const diagnostics = new Map<string, ToolDiagnosticInfo>()
    const disabled = PermissionNext.disabled(
      defs.map((item) => item.id),
      PermissionNext.merge(input.agent.permission, PermissionNext.sessionRuleset(input.session)),
    )
    const forcedGroups = forcedToolGroups(input.session)
    const forcedToolIDs = forcedTools(input.userTools)
    const ephemeralToolIds = new Set(input.ephemeralTools?.map((item) => item.id) ?? [])
    const canUseLightLoopReviewTools = await isRecordedLightLoopReviewSession(input)
    const canUseBlueprintLoopReviewTools = await isRecordedBlueprintLoopReviewSession(input)
    const canUseBlueprintLoopStop = await canStopBlueprintLoop(input)

    const supportsImageInput = input.model.capabilities.input.image

    for (const def of defs) {
      if (def.diagnostic) {
        diagnostics.set(def.id, def.diagnostic)
        continue
      }

      const isEphemeral = ephemeralToolIds.has(def.id)
      if (!isEphemeral && def.id === "look_at" && supportsImageInput) continue
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

      if (def.id === "blueprint_loop_stop" && !canUseBlueprintLoopStop) {
        diagnostics.set(
          def.id,
          SessionModePolicy.unavailable({
            toolName: def.id,
            reason: "blueprint_loop_required",
            session: input.session,
          }),
        )
        continue
      }

      if (def.id === "blueprint_loop_approve" || def.id === "blueprint_loop_reject") {
        if (!canUseBlueprintLoopReviewTools) {
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
      }

      if (def.id === "loop_stop" && input.session?.workflow?.kind !== "lightloop") {
        diagnostics.set(
          def.id,
          SessionModePolicy.unavailable({
            toolName: def.id,
            reason: "light_loop_required",
            session: input.session,
          }),
        )
        continue
      }

      if (def.id === "light_loop_approve" || def.id === "light_loop_reject") {
        if (!canUseLightLoopReviewTools) {
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

      if (!userToolAllows(def.id, input.userTools)) {
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

    return { visible, diagnostics }
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
        slot.fail(args, error.message, ToolDiagnostic.metadata(error.diagnostic))
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
                slot.complete(args, {
                  title: result.title,
                  output: result.output,
                  metadata: result.metadata ?? {},
                })
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
                slot.fail(args, message)
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
          const plugin = await Plugin.get(item.source.pluginId)
          if (plugin) markContributionDegraded(plugin, item.source.toolId, error)
        }
        const diagnostic = toolSchemaDiagnostic(item, error)
        log.warn("tool skipped due to schema failure", {
          tool: item.id,
          source: item.source,
          sessionID: input.sessionID,
          error: error instanceof Error ? error.message : String(error),
          diagnostic: diagnostic.message,
        })
        result.push({
          id: item.id,
          exposure: item.exposure,
          display: item.display,
          source: item.source,
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
                const workspace = ScopeContext.current.directory
                const workspaceInfo = ScopeContext.current.workspace
                const profileId = await Session.resolveEffectiveControlProfile({
                  sessionID: runtimeInput.session?.id,
                  agentControlProfile: runtimeInput.agent.controlProfile,
                })
                const synergyRoot = Global.Path.root
                const trustedRoots = SkillPaths.runtimeSkillRootCandidatesSync(workspace)
                const pluginToolIds = await currentPluginToolIds()
                const pluginGateData = await currentPluginGateData()
                const gate = await EnforcementGate.create({
                  activeWorkspace: workspace,
                  workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
                  originalCheckout: (workspaceInfo as any)?.originalCheckout,
                  registeredPluginTools: pluginToolIds,
                  pluginToolCapabilities: pluginGateData.toolCapabilities,
                  pluginApprovals: pluginGateData.approvals,
                  profileId,
                  readRoots: [synergyRoot, ...trustedRoots],
                  trustedRoots,
                  synergyRoot,
                })
                await toolTrace.phase("tool.resolver.ready", "resolver ready", {
                  profileId,
                  workspace,
                  workspaceType: workspaceInfo?.type ?? "scope",
                })

                const envelope = gate.evaluate(item.id, args as Record<string, any>)
                const modeDiagnostic = SessionModePolicy.evaluateCall({
                  toolName: item.id,
                  args: args as Record<string, any>,
                  session: runtimeInput.session,
                  capabilities: envelope.capabilities,
                })
                if (modeDiagnostic) throw new ToolDiagnosticError(modeDiagnostic)
                await applyGateApproval(ctx, gate, envelope, item.id, args as Record<string, any>, runtimeInput)
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
                    // Register externally-approved roots into the gate so the
                    // policy engine can aggregate them with auto-approved paths.
                    const extRoots = approvedExternalRoots(ctx)
                    if (extRoots.length > 0) {
                      gate.registerApprovedPaths(extRoots, extRoots, false)
                    }
                    const sandboxPolicy = gate.getSandboxPolicy()
                    const sandboxPrepare: BashSandboxPrepare = async (input) => {
                      await toolTrace?.phase("tool.sandbox.prepare", "sandbox prepare", {
                        mode: sandbox.mode,
                        backend: sandbox.backend,
                        fallback: sandbox.fallback,
                      })
                      const wrapper = SandboxBackend.prepareWrapper({
                        command: "/bin/sh",
                        args: ["-c", input.command],
                        workspace,
                        sandboxMode: sandbox.mode,
                        extraReadRoots: [synergyRoot, ...trustedRoots, ...extRoots, ...input.extraReadRoots],
                        extraWritableRoots: sandboxPolicy?.fileSystem.writableRoots ?? [],
                        protectedPaths: sandboxPolicy?.fileSystem.protectedPaths,
                        dataDenyRoots: sandboxPolicy?.fileSystem.dataDenyRoots,
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
                await Plugin.trigger(
                  "tool.execute.before",
                  {
                    tool: item.id,
                    sessionID: ctx.sessionID,
                    callID: ctx.callID,
                  },
                  {
                    args,
                  },
                )
                await toolTrace.phase("plugin.runtime.before.end", "plugin before end")
                await toolTrace.phase("tool.execute.start", "tool execute start")
                const result = await item.execute(args, toolCtx)
                Tool.validateAttachmentResult(item.id, result)
                await toolTrace.phase("tool.execute.end", "tool execute end", {
                  outputChars: result.output.length,
                  attachmentCount: result.attachments?.length ?? 0,
                })
                await toolTrace.phase("plugin.runtime.after.start", "plugin after start")
                await Plugin.trigger(
                  "tool.execute.after",
                  {
                    tool: item.id,
                    sessionID: ctx.sessionID,
                    callID: ctx.callID,
                  },
                  result,
                )
                await toolTrace.phase("plugin.runtime.after.end", "plugin after end")
                slot.complete(args, {
                  output: result.output,
                  title: result.title ?? "",
                  metadata: approvalFromContext(ctx)
                    ? { approval: approvalFromContext(ctx), ...(result.metadata ?? {}) }
                    : (result.metadata ?? {}),
                  attachments: result.attachments,
                  afterPersist: item.afterPersist ? () => item.afterPersist!(args, toolCtx, result) : undefined,
                })
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
                slot.fail(args, formatErrorForModel(error), metadataForError(error, approvalFromContext(ctx)))
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
      const mcpEntries = await MCP.toolEntries()
      const mcpToolNames = new Set(mcpEntries.map((entry) => entry.id))
      for (const entry of mcpEntries) {
        const key = entry.id
        const item = entry.tool
        const exposure = ToolExposure.mcpExposure(mcpEntries.length, entry.serverName)
        const schema = {
          ...((item.inputSchema as JSONSchema7 | undefined) ?? {}),
          type: "object",
          properties:
            (((item.inputSchema as JSONSchema7 | undefined)?.properties ?? {}) as JSONSchema7["properties"]) ?? {},
          additionalProperties: false,
        } satisfies JSONSchema7
        result.push({
          id: key,
          exposure,
          description: item.description ?? "",
          inputSchema: schema,
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
                  const workspace = ScopeContext.current.directory
                  const workspaceInfo = ScopeContext.current.workspace
                  const profileId = await Session.resolveEffectiveControlProfile({
                    sessionID: runtimeInput.session?.id,
                    agentControlProfile: runtimeInput.agent.controlProfile,
                  })
                  const trustedRoots = SkillPaths.runtimeSkillRootCandidatesSync(workspace)
                  const pluginToolIds = await currentPluginToolIds()
                  const pluginGateData = await currentPluginGateData()
                  const gate = await EnforcementGate.create({
                    activeWorkspace: workspace,
                    workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
                    originalCheckout: (workspaceInfo as any)?.originalCheckout,
                    registeredMcpTools: mcpToolNames,
                    registeredPluginTools: pluginToolIds,
                    pluginToolCapabilities: pluginGateData.toolCapabilities,
                    pluginApprovals: pluginGateData.approvals,
                    profileId,
                    readRoots: [Global.Path.root, ...trustedRoots],
                    synergyRoot: Global.Path.root,
                    trustedRoots,
                  })
                  await toolTrace.phase("tool.resolver.ready", "resolver ready", {
                    profileId,
                    workspace,
                    workspaceType: workspaceInfo?.type ?? "scope",
                  })
                  const envelope = gate.evaluate(key, args as Record<string, any>)
                  const modeDiagnostic = SessionModePolicy.evaluateCall({
                    toolName: key,
                    args: args as Record<string, any>,
                    session: runtimeInput.session,
                    capabilities: envelope.capabilities,
                  })
                  if (modeDiagnostic) throw new ToolDiagnosticError(modeDiagnostic)
                  await applyGateApproval(ctx, gate, envelope, key, args as Record<string, any>, runtimeInput)
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
                    mcpCallTimeoutMs: MCP.toolCallTimeout(key),
                  })
                  const combinedAbort = startToolTimeout(ctx, toolTimeoutMs)
                  ctx.abort = combinedAbort
                  await markExecutionStarted(runtimeInput, ctx, args as Record<string, any>, toolTimeout)
                  await toolTrace.phase("tool.execution.started", "execution started", {
                    timeoutMs: toolTimeoutMs,
                  })
                  using toolTimer = log.time("tool.execute", { tool: key, callID: opts.toolCallId })

                  await toolTrace.phase("plugin.runtime.before.start", "plugin before start")
                  await Plugin.trigger(
                    "tool.execute.before",
                    {
                      tool: key,
                      sessionID: ctx.sessionID,
                      callID: opts.toolCallId,
                    },
                    {
                      args,
                    },
                  )
                  await toolTrace.phase("plugin.runtime.before.end", "plugin before end")

                  await toolTrace.phase("tool.execute.start", "tool execute start")
                  const result = await execute(args, { ...opts, abortSignal: combinedAbort })
                  await toolTrace.phase("tool.execute.end", "tool execute end", {
                    contentCount: result.content.length,
                  })

                  await toolTrace.phase("plugin.runtime.after.start", "plugin after start")
                  await Plugin.trigger(
                    "tool.execute.after",
                    {
                      tool: key,
                      sessionID: ctx.sessionID,
                      callID: opts.toolCallId,
                    },
                    result,
                  )
                  await toolTrace.phase("plugin.runtime.after.end", "plugin after end")

                  const textParts: string[] = []
                  const attachments: MessageV2.AttachmentPart[] = []

                  for (const contentItem of result.content) {
                    if (contentItem.type === "text") {
                      textParts.push(contentItem.text)
                    } else if (contentItem.type === "image") {
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
                  }

                  const output = {
                    title: "",
                    metadata: result.metadata ?? {},
                    output: textParts.join("\n\n"),
                    attachments,
                    content: result.content,
                  }
                  Tool.validateAttachmentResult(key, output)

                  slot.complete(args, {
                    output: output.output,
                    title: output.title,
                    metadata: approvalFromContext(ctx)
                      ? { approval: approvalFromContext(ctx), ...output.metadata }
                      : output.metadata,
                    attachments: output.attachments,
                  })
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
                  slot.fail(args, formatErrorForModel(error), metadataForError(error, approvalFromContext(ctx)))
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

  function withExecutionDeduplication(input: Input, runtimeTool: AITool): AITool {
    const execute = runtimeTool.execute
    if (!execute) return runtimeTool
    return {
      ...runtimeTool,
      execute(args, options) {
        return input.processor.executeOnce(options.toolCallId, () => execute.call(runtimeTool, args, options))
      },
    } as AITool
  }

  export async function resolveWithAvailability(input: Input): Promise<ResolvedTools> {
    using _ = log.time("resolveWithAvailability")
    const tools: Record<string, AITool> = {}
    const availabilityResult = await availability(input)

    for (const item of availabilityResult.visible) {
      const runtimeTool = item.createRuntimeTool?.(input)
      if (runtimeTool) {
        tools[item.id] = withExecutionDeduplication(input, runtimeTool)
      }
    }

    for (const diagnostic of availabilityResult.diagnostics.values()) {
      if (tools[diagnostic.toolName]) continue
      tools[diagnostic.toolName] = withExecutionDeduplication(input, diagnosticRuntimeTool(input, diagnostic))
    }

    return {
      tools,
      activeToolIDs: availabilityResult.visible.map((item) => item.id),
    }
  }

  export async function resolve(input: Input): Promise<Record<string, AITool>> {
    using _ = log.time("resolve")
    const tools: Record<string, AITool> = {}
    const defs = await definitions(input)

    for (const item of defs) {
      const runtimeTool = item.createRuntimeTool?.(input)
      if (runtimeTool) tools[item.id] = withExecutionDeduplication(input, runtimeTool)
    }

    return tools
  }
}
