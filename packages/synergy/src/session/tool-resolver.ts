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
import { toolCapabilities } from "../plugin/capability"
import { computeRisk } from "../plugin/consent/risk"
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
import type { Info } from "./types"
import type { MessageV2 } from "./message-v2"
import type { SessionProcessor } from "./processor"
import { ScopeContext } from "@/scope/context"
import { EnforcementGate, type Capability } from "@/enforcement/gate"
import { SandboxBackend } from "@/sandbox/backend"
import type { SandboxExecutionWrapper } from "@/sandbox/backend"
import type { ProfileId, ResolvedProfile } from "@/control-profile/types"
import { EnforcementError } from "@/enforcement/errors"
import { Config } from "@/config/config"
import { ControlProfileCompiler } from "@/control-profile/compiler"
import { ApprovalPolicy, type ApprovalMetadata } from "@/control-profile/approval"
import { ExecutionBudget } from "@/util/execution-budget"
import { Observability } from "@/observability"

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
    description: string
    inputSchema: JSONSchema7
    createRuntimeTool?(input: Input): AITool
  }

  /**
   * Resolve the effective control profile id using precedence:
   *   1. session controlProfile (resolved from parent chain)
   *   2. agent config controlProfile
   *   3. top-level config controlProfile
   *   4. default 'guarded'
   */
  function resolveEffectiveProfile(agent: Agent.Info, topLevelProfile?: string, sessionProfile?: string): ProfileId {
    return ControlProfileCompiler.normalize(sessionProfile ?? agent.controlProfile ?? topLevelProfile)
  }

  /** Cached config lookup to avoid repeated Config.current() inside tool execute. */
  let _cachedConfig: { controlProfile?: string } | null = null
  async function cachedTopLevelProfile(): Promise<string | undefined> {
    if (_cachedConfig === null) {
      try {
        _cachedConfig = { controlProfile: (await Config.current()).controlProfile }
      } catch {
        _cachedConfig = {}
      }
    }
    return _cachedConfig.controlProfile
  }

  /** Cached plugin tool IDs (prefixed) for enforcement gate registration. */
  let _cachedPluginToolIds: Set<string> | null = null
  let _cachedPluginGateData: {
    toolCapabilities: Record<string, { capabilities: string[]; risk: "low" | "medium" | "high" }>
    approvals: Record<string, PluginApprovalRecord>
  } | null = null
  async function cachedPluginToolIds(): Promise<Set<string>> {
    if (_cachedPluginToolIds === null) {
      const ids = new Set<string>()
      for (const plugin of await Plugin.perPluginHooks()) {
        for (const toolId of Object.keys(plugin.hooks.tool ?? {})) {
          ids.add(PluginToolId.format(plugin.id, toolId))
        }
      }
      _cachedPluginToolIds = ids
    }
    return _cachedPluginToolIds
  }

  async function cachedPluginGateData() {
    if (_cachedPluginGateData === null) {
      const caps: Record<string, { capabilities: string[]; risk: "low" | "medium" | "high" }> = {}
      const approvals: Record<string, PluginApprovalRecord> = {}
      for (const plugin of await Plugin.getLoaded()) {
        const manifest = await Plugin.manifest(plugin.id).catch(() => null)
        const risk = manifest ? computeRisk(toolCapabilities(manifest, ""), manifest) : "low"
        for (const toolId of Object.keys(plugin.hooks.tool ?? {})) {
          caps[PluginToolId.format(plugin.id, toolId)] = {
            capabilities: toolCapabilities(manifest, toolId),
            risk,
          }
        }
        const approval = await getApproval(plugin.id)
        if (approval) approvals[plugin.id] = approval
      }
      _cachedPluginGateData = { toolCapabilities: caps, approvals }
    }
    return _cachedPluginGateData
  }

  /**
   * Derive an external path string from tool args for use in nonBypassable
   * permission asks triggered by the enforcement gate.
   */
  function externalPathFromArgs(toolName: string, args: Record<string, any>): string {
    if (toolName === "bash") return (args.workdir ?? args.command) as string
    //     if (toolName === "agora_join" || toolName === "agora_accept") return (args.directory ?? "") as string
    if (toolName === "look_at" || toolName === "attach") {
      const raw = args.file_path ?? args.filePath ?? ""
      return Array.isArray(raw) ? (raw[0] ?? "") : String(raw)
    }
    return (args.filePath ?? args.path ?? args.pattern ?? "") as string
  }

  function permissionForGateCapability(toolName: string, className: string): string {
    if (className === "file_external_read" || className === "file_external_write") return "external_directory"
    if (className === "shell_read") return "bash"
    if (className === "shell_destructive") return "bash"
    if (className === "network_request")
      return toolName === "webfetch" || toolName === "websearch" ? toolName : "network_request"
    return className
  }

  function patternsForGateCapability(toolName: string, cap: Capability, args: Record<string, any>): string[] {
    if (cap.class === "file_external_read" || cap.class === "file_external_write")
      return cap.paths?.length ? cap.paths : [externalPathFromArgs(toolName, args) || "*"]
    if (cap.class === "shell_destructive") return [String(args.command ?? "*")]
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
    executionBudget?: ExecutionBudget.Info
    sessionAbort: AbortSignal
  }

  function toolTiming(ctx: Tool.Context): ToolTiming {
    return (ctx.extra as any).toolTiming as ToolTiming
  }

  interface ToolTrace {
    traceId: string
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

    await emit("tool.start", { args })

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
        }
      },
      Math.max(5_000, Math.min(stalledMs, TOOL_HEARTBEAT_MS)),
    )
    if (typeof heartbeat === "object" && "unref" in heartbeat) heartbeat.unref()
    if (typeof stale === "object" && "unref" in stale) stale.unref()

    return {
      traceId,
      async phase(type, nextPhase, data, level) {
        phase = nextPhase
        lastActivity = Date.now()
        await emit(type, data, level)
      },
      async end(data) {
        phase = "end"
        lastActivity = Date.now()
        await emit("tool.end", data)
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
        metadata: ToolTimeout.preserveMetadata(match.state.metadata, state.metadata) ?? match.state.metadata,
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

  function startExecutionBudget(ctx: Tool.Context, timeoutMs: number) {
    const timing = toolTiming(ctx)
    const budget = ExecutionBudget.create(timeoutMs)
    timing.executionBudget = budget
    return AbortSignal.any([timing.sessionAbort, budget.signal])
  }

  function disposeExecutionBudget(ctx: Tool.Context) {
    const timing = toolTiming(ctx)
    timing.executionBudget?.dispose()
    timing.executionBudget = undefined
  }

  async function pauseExecutionBudgetForApproval<T>(ctx: Tool.Context, fn: () => Promise<T>): Promise<T> {
    const budget = toolTiming(ctx).executionBudget
    budget?.pause()
    try {
      return await fn()
    } finally {
      budget?.resume()
    }
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
    const policyDecision = ApprovalPolicy.decideCapabilities(approval, envelope.capabilities)
    // envelope.decision is authoritative — the gate already merged profile rules,
    // exec-policy, and approval cache. policyDecision provides risk/capabilities
    // metadata only; its .action is discarded.
    const decision = { ...policyDecision, action: envelope.decision }

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
        const classification = await SmartAllow.classify({
          sessionID: ctx.sessionID,
          tool: toolName,
          args,
          capabilities: envelope.capabilities.map((c) => c.class),
          workspace: ScopeContext.current.directory,
          policyAction: decision.action,
        })
        if (SmartAllow.shouldAutoAllow(classification, ctx.sessionID)) {
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

  async function setApprovalMetadata(ctx: Tool.Context, approval: ApprovalMetadata) {
    const stamped = stampApprovalTiming(ctx, approval)
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
            const topLevelProfile = await cachedTopLevelProfile()
            const sessionProfile = input.session?.id ? await Session.resolveControlProfile(input.session.id) : undefined
            const profileId = resolveEffectiveProfile(input.agent, topLevelProfile, sessionProfile)
            const workspaceInfo = ScopeContext.current.workspace
            const interaction = input.session?.interaction
            const interactionMode = interaction?.mode === "unattended" ? "unattended" : "attended"
            return ControlProfileCompiler.resolve(profileId, {
              workspace: ScopeContext.current.directory,
              workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
              interactionMode,
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
          const requestMetadata = {
            ...req.metadata,
            ...PermissionNext.requestMetadata(input.session),
          }
          const decision = ApprovalPolicy.decidePermission(profile.approval, req.permission, requestMetadata)
          if (decision.action === "deny") {
            const approval = ApprovalPolicy.metadata(profile.approval, decision, "auto_denied")
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
            await pauseExecutionBudgetForApproval(ctx, () =>
              PermissionNext.ask({
                ...req,
                sessionID: input.sessionID,
                tool: { messageID: input.processor.message.id, callID: options.toolCallId },
                metadata: requestMetadata,
                ruleset: PermissionNext.merge(
                  input.agent.permission,
                  PermissionNext.sessionRuleset(input.session),
                  forcedAsk,
                ),
                signal: toolTiming(ctx).sessionAbort,
              }),
            )
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

  const PLAN_MODE_ALLOWED_TOOLS = new Set([
    // Read tools
    "read",
    "glob",
    "grep",
    "view_file",
    "scan_files",
    "parse_code",
    "look_at",
    "scan_document",
    "ast_grep",
    "lsp",
    // Session read
    "session_list",
    "session_read",
    "session_search",
    // Note read
    "note_list",
    "note_read",
    "note_search",
    "note_write",
    "note_edit",
    // Memory read
    "memory_search",
    "memory_get",
    // Coordination read/write
    "task_list",
    "task_output",
    "dagread",
    "dagwrite",
    "dagpatch",
    "task",
    "task_cancel",
    // UI
    "question",
    "skill",
    "search_tools",
    "expand_tools",
    // Network
    "websearch",
    "webfetch",
    // Agenda read
    "agenda_list",
    "agenda_logs",
    // Platform read
    "worktree_list",
  ])

  function forcedToolGroups(session?: Info) {
    const result = new Set<string>()
    if (session?.blueprint?.planMode || session?.blueprint?.loopID) {
      result.add("note")
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

  export async function definitions(input: Omit<Input, "processor">): Promise<Definition[]> {
    using _ = log.time("definitions")
    let result: Definition[] = []
    const ephemeralToolIds = new Set(input.ephemeralTools?.map((item) => item.id) ?? [])

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
              let resolveExecution!: (outcome: SessionProcessor.ToolOutcome) => void
              const executionPromise = new Promise<SessionProcessor.ToolOutcome>((r) => {
                resolveExecution = r
              })
              runtimeInput.processor.trackExecution(options.toolCallId, executionPromise)

              try {
                const result = await item.execute(args as Record<string, unknown>)
                resolveExecution({
                  status: "completed",
                  input: args,
                  result: {
                    title: result.title,
                    output: result.output,
                    metadata: result.metadata ?? {},
                  },
                })
                return {
                  title: result.title,
                  output: result.output,
                  metadata: result.metadata ?? {},
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                resolveExecution({
                  status: "error",
                  input: args,
                  error: message,
                })
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
      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters), {
        tool: item.id,
      }) as JSONSchema7
      result.push({
        id: item.id,
        exposure: item.exposure,
        display: item.display,
        description: item.description,
        inputSchema: schema,
        createRuntimeTool(runtimeInput) {
          const context = contextFactory(runtimeInput)
          return tool({
            id: item.id as any,
            description: item.description,
            inputSchema: jsonSchema(schema),
            async execute(args, options) {
              const ctx = context(args, options)
              let toolTrace: ToolTrace | undefined
              let resolveExecution!: (outcome: SessionProcessor.ToolOutcome) => void
              const executionPromise = new Promise<SessionProcessor.ToolOutcome>((r) => {
                resolveExecution = r
              })
              runtimeInput.processor.trackExecution(options.toolCallId, executionPromise)

              try {
                toolTrace = await startToolTrace(runtimeInput, ctx, item.id, args as Record<string, unknown>)
                const workspace = ScopeContext.current.directory
                const workspaceInfo = ScopeContext.current.workspace
                const interaction = runtimeInput.session?.interaction
                const interactionMode = interaction?.mode === "unattended" ? "unattended" : "attended"
                const topLevelProfile = await cachedTopLevelProfile()
                const sessionProfile = runtimeInput.session?.id
                  ? await Session.resolveControlProfile(runtimeInput.session.id)
                  : undefined
                const profileId = resolveEffectiveProfile(runtimeInput.agent, topLevelProfile, sessionProfile)
                const synergyRoot = Global.Path.root
                const pluginToolIds = await cachedPluginToolIds()
                const pluginGateData = await cachedPluginGateData()
                const gate = await EnforcementGate.create({
                  activeWorkspace: workspace,
                  workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
                  interactionMode,
                  originalCheckout: (workspaceInfo as any)?.originalCheckout,
                  registeredPluginTools: pluginToolIds,
                  pluginToolCapabilities: pluginGateData.toolCapabilities,
                  pluginApprovals: pluginGateData.approvals,
                  profileId,
                  readRoots: [synergyRoot],
                })
                await toolTrace.phase("tool.resolver.ready", "resolver ready", {
                  profileId,
                  workspace,
                  workspaceType: workspaceInfo?.type ?? "scope",
                })

                const envelope = gate.evaluate(item.id, args as Record<string, any>)
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
                  executionBudgetMs: toolTimeoutMs,
                })
                const combinedAbort = startExecutionBudget(ctx, toolTimeoutMs)
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
                resolveExecution({
                  status: "completed",
                  input: args,
                  result: {
                    output: result.output,
                    title: result.title ?? "",
                    metadata: approvalFromContext(ctx)
                      ? { approval: approvalFromContext(ctx), ...(result.metadata ?? {}) }
                      : (result.metadata ?? {}),
                    attachments: result.attachments,
                  },
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
                resolveExecution({
                  status: "error",
                  input: args,
                  error: formatErrorForModel(error),
                  metadata: approvalFromContext(ctx) ? { approval: approvalFromContext(ctx) } : undefined,
                })
                await toolTrace?.error(error)
                throw error
              } finally {
                toolTrace?.dispose()
                disposeExecutionBudget(ctx)
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
                const ctx = context(args, opts)
                let toolTrace: ToolTrace | undefined
                let resolveExecution!: (outcome: SessionProcessor.ToolOutcome) => void
                const executionPromise = new Promise<SessionProcessor.ToolOutcome>((r) => {
                  resolveExecution = r
                })
                runtimeInput.processor.trackExecution(opts.toolCallId, executionPromise)

                try {
                  toolTrace = await startToolTrace(runtimeInput, ctx, key, args as Record<string, unknown>)
                  const workspace = ScopeContext.current.directory
                  const workspaceInfo = ScopeContext.current.workspace
                  const interaction = runtimeInput.session?.interaction
                  const interactionMode = interaction?.mode === "unattended" ? "unattended" : "attended"
                  const topLevelProfile = await cachedTopLevelProfile()
                  const sessionProfile = runtimeInput.session?.id
                    ? await Session.resolveControlProfile(runtimeInput.session.id)
                    : undefined
                  const profileId = resolveEffectiveProfile(runtimeInput.agent, topLevelProfile, sessionProfile)
                  const pluginToolIds = await cachedPluginToolIds()
                  const pluginGateData = await cachedPluginGateData()
                  const gate = await EnforcementGate.create({
                    activeWorkspace: workspace,
                    workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
                    interactionMode,
                    originalCheckout: (workspaceInfo as any)?.originalCheckout,
                    registeredMcpTools: mcpToolNames,
                    registeredPluginTools: pluginToolIds,
                    pluginToolCapabilities: pluginGateData.toolCapabilities,
                    pluginApprovals: pluginGateData.approvals,
                    profileId,
                  })
                  await toolTrace.phase("tool.resolver.ready", "resolver ready", {
                    profileId,
                    workspace,
                    workspaceType: workspaceInfo?.type ?? "scope",
                  })
                  const envelope = gate.evaluate(key, args as Record<string, any>)
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
                    executionBudgetMs: toolTimeoutMs,
                    mcpCallTimeoutMs: MCP.toolCallTimeout(key),
                  })
                  const combinedAbort = startExecutionBudget(ctx, toolTimeoutMs)
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
                  const attachments: MessageV2.FilePart[] = []

                  for (const contentItem of result.content) {
                    if (contentItem.type === "text") {
                      textParts.push(contentItem.text)
                    } else if (contentItem.type === "image") {
                      attachments.push({
                        id: Identifier.ascending("part"),
                        sessionID: runtimeInput.sessionID,
                        messageID: runtimeInput.processor.message.id,
                        type: "file",
                        mime: contentItem.mimeType,
                        url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
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

                  resolveExecution({
                    status: "completed",
                    input: args,
                    result: {
                      output: output.output,
                      title: output.title,
                      metadata: approvalFromContext(ctx)
                        ? { approval: approvalFromContext(ctx), ...output.metadata }
                        : output.metadata,
                      attachments: output.attachments,
                    },
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
                  resolveExecution({
                    status: "error",
                    input: args,
                    error: formatErrorForModel(error),
                    metadata: approvalFromContext(ctx) ? { approval: approvalFromContext(ctx) } : undefined,
                  })
                  await toolTrace?.error(error)
                  throw error
                } finally {
                  toolTrace?.dispose()
                  disposeExecutionBudget(ctx)
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

    result = result.filter((d) =>
      ToolExposure.isVisible(d.id, d.exposure, input.session?.toolState, {
        forcedGroups: forcedToolGroups(input.session),
        forcedTools: forcedTools(input.userTools),
      }),
    )

    if (input.session?.blueprint?.planMode) {
      result = result.filter((d) => PLAN_MODE_ALLOWED_TOOLS.has(d.id) || ephemeralToolIds.has(d.id))
    }

    const activeBlueprintLoopID = input.session?.blueprint?.loopID
    const isSupervisor = input.agent.name === "supervisor"
    if (!isSupervisor) {
      result = result.filter((d) => d.id !== "blueprint_loop_restart")
    }
    if (!isSupervisor && !activeBlueprintLoopID) {
      result = result.filter((d) => d.id !== "blueprint_loop_finish")
    }
    const disabled = PermissionNext.disabled(
      result.map((item) => item.id),
      PermissionNext.merge(input.agent.permission, PermissionNext.sessionRuleset(input.session)),
    )

    return result.filter(
      (item) => (!disabled.has(item.id) || ephemeralToolIds.has(item.id)) && userToolAllows(item.id, input.userTools),
    )
  }

  export async function resolve(input: Input): Promise<Record<string, AITool>> {
    using _ = log.time("resolve")
    const tools: Record<string, AITool> = {}
    const defs = await definitions(input)

    for (const item of defs) {
      const runtimeTool = item.createRuntimeTool?.(input)
      if (runtimeTool) {
        tools[item.id] = runtimeTool
      }
    }

    return tools
  }
}
