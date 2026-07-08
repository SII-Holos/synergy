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
import type { MessageV2 } from "./message-v2"
import type { SessionProcessor } from "./processor"
import { ScopeContext } from "@/scope/context"
import { EnforcementGate, type Capability } from "@/enforcement/gate"
import { SandboxBackend } from "@/sandbox/backend"
import type { SandboxExecutionWrapper } from "@/sandbox/backend"
import type { ResolvedProfile } from "@/control-profile/types"
import { EnforcementError } from "@/enforcement/errors"
import { Config } from "@/config/config"
import { ControlProfileCompiler } from "@/control-profile/compiler"
import { ApprovalPolicy, type ApprovalMetadata } from "@/control-profile/approval"
import { Observability } from "@/observability"
import { SessionModePolicy } from "./tool-mode-policy"
import { ToolDiagnostic, ToolDiagnosticError, type ToolDiagnostic as ToolDiagnosticInfo } from "@/tool/diagnostic"
import { PerformanceIssues } from "@/performance/issues"
import { PerformanceMetrics } from "@/performance/metrics"
import { SkillPaths } from "@/skill/paths"
import { PerformanceSpans } from "@/performance/spans"

export namespace ToolResolver {
  const log = Log.create({ service: "tool.resolver" })
  const neverAbort = new AbortController().signal
  const DEFAULT_STALLED_TOOL_MS = 30_000
  const TOOL_HEARTBEAT_MS = 15_000

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
    for (const plugin of await Plugin.perPluginHooks()) {
      for (const toolId of Object.keys(plugin.hooks.tool ?? {})) {
        ids.add(PluginToolId.format(plugin.id, toolId))
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
        for (const toolId of Object.keys(plugin.hooks.tool ?? {})) {
          const capabilities = toolCapabilities(manifest, toolId)
          caps[PluginToolId.format(plugin.id, toolId)] = {
            capabilities,
            risk: toolRisk(manifest, toolId),
          }
        }
        const approval = await getApproval(plugin.id)
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
    span: PerformanceSpans.SpanContext | undefined
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
    const traceId = Observability.traceId("tool")
    ;(ctx.extra as any).traceId = traceId
    const startedAt = Date.now()
    let phase = "start"
    let lastActivity = startedAt
    let stalled = false
    const stalledMs = await stalledToolMs()
    const perfSpan = PerformanceSpans.start({
      name: "tool.execution",
      module: "tool",
      traceId,
      sessionID: input.sessionID,
      messageID: input.processor.message.id,
      callID: ctx.callID,
      tool: toolName,
      attributes: { tool: toolName },
    })
    PerformanceMetrics.record({
      name: "tool.execution.count",
      value: 1,
      unit: "count",
      module: "tool",
      traceId,
      spanId: perfSpan?.spanId,
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
      cwd: ScopeContext.current.directory,
      scopeID: ScopeContext.current.scope.id,
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

    const heartbeat = setInterval(() => {
      void emit("tool.heartbeat", {
        idleMs: Date.now() - lastActivity,
      })
    }, TOOL_HEARTBEAT_MS)
    const stale = setInterval(
      () => {
        const idleMs = Date.now() - lastActivity
        if (!stalled && idleMs >= stalledMs) {
          stalled = true
          void emit(
            "tool.stalled",
            {
              idleMs,
              thresholdMs: stalledMs,
            },
            "warn",
          )
          PerformanceMetrics.record({
            name: "tool.execution.stalled",
            value: 1,
            unit: "count",
            module: "tool",
            traceId,
            spanId: perfSpan?.spanId,
            sessionID: input.sessionID,
            messageID: input.processor.message.id,
            callID: ctx.callID,
            tool: toolName,
            labels: { phase },
          })
          PerformanceIssues.raise({
            code: "PERF_TOOL_STALLED",
            severity: "warning",
            module: "tool",
            title: "Tool execution stalled",
            message: `${toolName} has not reported activity for ${idleMs}ms`,
            recommendation: "Inspect the tool trace and owning tool implementation.",
            traceId,
            spanId: perfSpan?.spanId,
            sessionID: input.sessionID,
            messageID: input.processor.message.id,
            callID: ctx.callID,
            evidence: { idleMs, thresholdMs: stalledMs, tool: toolName },
          })
        }
      },
      Math.max(5_000, Math.min(stalledMs, TOOL_HEARTBEAT_MS)),
    )
    if (typeof heartbeat === "object" && "unref" in heartbeat) heartbeat.unref()
    if (typeof stale === "object" && "unref" in stale) stale.unref()

    return {
      traceId,
      span: perfSpan,
      async phase(type, nextPhase, data, level) {
        const previousPhase = phase
        phase = nextPhase
        const now = Date.now()
        PerformanceMetrics.record({
          name: "tool.phase.duration",
          value: now - lastActivity,
          unit: "ms",
          module: "tool",
          traceId,
          spanId: perfSpan?.spanId,
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
        await emit("tool.end", data)
        PerformanceSpans.end(perfSpan, { attributes: data })
      },
      async error(error, data) {
        phase = "error"
        lastActivity = Date.now()
        await emit(
          "tool.error",
          {
            ...data,
            error:
              error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
          },
          "error",
        )
        PerformanceMetrics.record({
          name: "tool.execution.error",
          value: 1,
          unit: "count",
          module: "tool",
          traceId,
          spanId: perfSpan?.spanId,
          sessionID: input.sessionID,
          messageID: input.processor.message.id,
          callID: ctx.callID,
          tool: toolName,
          labels: { errorName: error instanceof Error ? error.name : "unknown" },
        })
        PerformanceSpans.end(perfSpan, { status: "error", error, attributes: data })
      },
      dispose() {
        clearInterval(heartbeat)
        clearInterval(stale)
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
    session?: Info,
  ) {
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
        const classification = await SmartAllow.classify({
          sessionID: ctx.sessionID,
          tool: toolName,
          args,
          capabilities: envelope.capabilities.map((c) => c.class),
          workspace: ScopeContext.current.directory,
          policyAction: decision.action,
          redactedEvidence,
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
      await setApprovalMetadata(ctx, { ...metadata, reason: diagnosticReason })
      throw new EnforcementError.PolicyDenied(diagnosticReason, decision.capabilities, envelope.profileId)
    }

    if (profile.profileId === "autonomous" && decision.action === "ask") {
      const diagnosticReason = envelope.refusal?.reason ?? decision.reason
      const metadata = ApprovalPolicy.metadata(approval, { ...decision, action: "deny" }, "auto_denied")
      await setApprovalMetadata(ctx, { ...metadata, reason: diagnosticReason })
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

  function applyAvailability(defs: Definition[], input: Omit<Input, "processor">): Availability {
    const visible: Definition[] = []
    const diagnostics = new Map<string, ToolDiagnosticInfo>()
    const disabled = PermissionNext.disabled(
      defs.map((item) => item.id),
      PermissionNext.merge(input.agent.permission, PermissionNext.sessionRuleset(input.session)),
    )
    const activeBlueprintLoopID = input.session?.blueprint?.loopID
    const blueprintLoopRole = input.session?.blueprint?.loopRole
    const forcedGroups = forcedToolGroups(input.session)
    const forcedToolIDs = forcedTools(input.userTools)
    const ephemeralToolIds = new Set(input.ephemeralTools?.map((item) => item.id) ?? [])

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

      if (def.id === "blueprint_loop_restart" && (!activeBlueprintLoopID || blueprintLoopRole !== "audit")) {
        diagnostics.set(
          def.id,
          SessionModePolicy.unavailable({
            toolName: def.id,
            reason: "audit_only",
            session: input.session,
          }),
        )
        continue
      }

      if (def.id === "blueprint_loop_finish" && !activeBlueprintLoopID) {
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

      // light_loop_approve / light_loop_reject are gated by execution-time
      // checks (stopRequest.reviewSessionID === ctx.sessionID) and the
      // lightLoopReviewer permission profile. Hide them from sessions that
      // aren't the recorded review session.
      if (def.id === "light_loop_approve" || def.id === "light_loop_reject") {
        const wf = input.session?.workflow
        if (wf?.kind !== "lightloop" || wf.stopRequest?.reviewSessionID !== input.session?.id) {
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
        ? `Plugin tool ${item.id} uses an incompatible input schema. Plugin tools must define args with zod >=4.`
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
              log.info("tool.execute.callback.slot", {
                tool: item.id,
                sessionID: runtimeInput.sessionID,
                messageID: runtimeInput.processor.message.id,
                callID: options.toolCallId,
                kind: "ephemeral",
                slotStatus: slot.status,
              })
              try {
                const result = await item.execute(args as Record<string, unknown>)
                slot.complete(args, {
                  title: result.title,
                  output: result.output,
                  metadata: result.metadata ?? {},
                })
                return {
                  title: result.title,
                  output: result.output,
                  metadata: result.metadata ?? {},
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                slot.fail(args, message)
                throw error
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
        schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters), {
          tool: item.id,
        }) as JSONSchema7
      } catch (error) {
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
                const trustedRoots = SkillPaths.runtimeSkillRootsSync(workspace)
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
                  readRoots: [synergyRoot],
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
                await applyGateApproval(ctx, gate, envelope, item.id, args as Record<string, any>, runtimeInput.session)
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
                let sandboxWrapper: SandboxExecutionWrapper | undefined
                if (item.id === "bash") {
                  const sandbox = gate.getSandbox()
                  if (sandbox.mode !== "none" && !shouldBypassShellSandbox(ctx)) {
                    await toolTrace.phase("tool.sandbox.prepare", "sandbox prepare", {
                      mode: sandbox.mode,
                      backend: sandbox.backend,
                      fallback: sandbox.fallback,
                    })
                    const bashCommand = ((args as Record<string, any>)?.command as string) ?? ""
                    // Register externally-approved roots into the gate so the
                    // policy engine can aggregate them with auto-approved paths.
                    const extRoots = approvedExternalRoots(ctx)
                    if (extRoots.length > 0) {
                      gate.registerApprovedPaths(extRoots, extRoots, false)
                    }
                    const sandboxPolicy = gate.getSandboxPolicy()
                    sandboxWrapper = SandboxBackend.prepareWrapper({
                      command: "/bin/sh",
                      args: ["-c", bashCommand],
                      workspace,
                      sandboxMode: sandbox.mode,
                      extraReadRoots: [synergyRoot, ...extRoots],
                      extraWritableRoots: sandboxPolicy?.fileSystem.writableRoots ?? [],
                      protectedPaths: sandboxPolicy?.fileSystem.protectedPaths,
                      dataDenyRoots: sandboxPolicy?.fileSystem.dataDenyRoots,
                      backend: sandbox.backend,
                    })
                    if (sandboxWrapper.skipReason) {
                      if (sandbox.fallback === "deny") {
                        throw new Error(`Sandbox required but unavailable: ${sandboxWrapper.skipReason}`)
                      }
                      // warn fallback: log warning and surface in context for bash tool to include in output
                      log.warn("sandbox.unavailable", { skipReason: sandboxWrapper.skipReason })
                      ;(toolCtx.extra as any).sandboxWarning = sandboxWrapper.skipReason
                    }
                    // Store wrapper in context for bash tool to use
                    ;(toolCtx.extra as any).sandboxWrapper = sandboxWrapper
                    ;(toolCtx.extra as any).sandboxFallback = sandbox.fallback
                    await toolTrace.phase("tool.sandbox.prepared", "sandbox prepared", {
                      skipReason: sandboxWrapper.skipReason,
                      command: sandboxWrapper.command,
                      args: sandboxWrapper.args,
                    })
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
                  const trustedRoots = SkillPaths.runtimeSkillRootsSync(workspace)
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
                  await applyGateApproval(ctx, gate, envelope, key, args as Record<string, any>, runtimeInput.session)
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
    return applyAvailability(await collectDefinitions(input), input)
  }

  export async function definitions(input: Omit<Input, "processor">): Promise<Definition[]> {
    return (await availability(input)).visible
  }

  export async function resolveWithAvailability(input: Input): Promise<ResolvedTools> {
    using _ = log.time("resolveWithAvailability")
    const tools: Record<string, AITool> = {}
    const availabilityResult = await availability(input)

    for (const item of availabilityResult.visible) {
      const runtimeTool = item.createRuntimeTool?.(input)
      if (runtimeTool) {
        tools[item.id] = runtimeTool
      }
    }

    for (const diagnostic of availabilityResult.diagnostics.values()) {
      if (tools[diagnostic.toolName]) continue
      tools[diagnostic.toolName] = diagnosticRuntimeTool(input, diagnostic)
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
      if (runtimeTool) tools[item.id] = runtimeTool
    }

    return tools
  }
}
