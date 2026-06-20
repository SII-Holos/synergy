import { Global } from "@/global"
import { type Tool as AITool, tool, jsonSchema, type ToolCallOptions, type JSONSchema7 } from "ai"
import z from "zod"
import { Agent } from "@/agent/agent"
import { Identifier } from "@/id/id"
import { MCP } from "@/mcp"
import { PermissionNext } from "@/permission/next"
import { Plugin } from "@/plugin"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Log } from "@/util/log"
import { TimeoutConfig } from "@/util/timeout-config"
import { Session } from "."
import type { Info } from "./types"
import type { MessageV2 } from "./message-v2"
import type { SessionProcessor } from "./processor"
import { Instance } from "@/scope/instance"
import { EnforcementGate, type Capability } from "@/enforcement/gate"
import { SandboxBackend } from "@/sandbox/backend"
import type { SandboxExecutionWrapper } from "@/sandbox/backend"
import type { ProfileId, ResolvedProfile } from "@/control-profile/types"
import { EnforcementError } from "@/enforcement/errors"
import { Config } from "@/config/config"
import { ControlProfileCompiler } from "@/control-profile/compiler"
import { ApprovalPolicy, type ApprovalMetadata } from "@/control-profile/approval"
import { ExecutionBudget } from "@/util/execution-budget"

export namespace ToolResolver {
  const log = Log.create({ service: "tool.resolver" })
  const neverAbort = new AbortController().signal

  export interface Input {
    agent: Agent.Info
    model: Provider.Model
    sessionID: string
    processor: SessionProcessor.Info
    session?: Info
    userTools?: Record<string, boolean>
    includeMCP?: boolean
  }

  export interface Definition {
    id: string
    description: string
    inputSchema: JSONSchema7
    createRuntimeTool?(input: Input): AITool
  }

  /**
   * Resolve the effective control profile id using precedence:
   *   1. session controlProfile
   *   2. agent config controlProfile
   *   3. top-level config controlProfile
   *   4. default 'guarded'
   */
  function resolveEffectiveProfile(agent: Agent.Info, topLevelProfile?: string, session?: Info): ProfileId {
    return ControlProfileCompiler.normalize(session?.controlProfile ?? agent.controlProfile ?? topLevelProfile)
  }

  /** Cached config lookup to avoid repeated Config.get() inside tool execute. */
  let _cachedConfig: { controlProfile?: string } | null = null
  async function cachedTopLevelProfile(): Promise<string | undefined> {
    if (_cachedConfig === null) {
      try {
        _cachedConfig = { controlProfile: (await Config.get()).controlProfile }
      } catch {
        _cachedConfig = {}
      }
    }
    return _cachedConfig.controlProfile
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
    if (className === "file_external") return "external_directory"
    if (className === "shell_read") return "bash"
    if (className === "shell_destructive") return "bash"
    if (className === "network_request")
      return toolName === "webfetch" || toolName === "websearch" ? toolName : "network_request"
    return className
  }

  function patternsForGateCapability(toolName: string, cap: Capability, args: Record<string, any>): string[] {
    if (cap.class === "file_external")
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
      approval.status === "not_required"
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
        metadata: state.metadata ?? match.state.metadata,
        status: "running",
        input: args,
        time: {
          start: state.start ?? match.state.time.start,
        },
      },
    })
    Object.assign(match, updated)
  }

  async function markExecutionStarted(input: Input, ctx: Tool.Context, args: Record<string, any>) {
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
      ...(approvalFromContext(ctx) ? { approval: approvalFromContext(ctx) } : {}),
    }
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
  ) {
    const profile = gate.getProfileInfo()
    const approval = profile.approval
    const policyDecision = ApprovalPolicy.decideCapabilities(approval, envelope.capabilities)
    const decision = { ...policyDecision, action: envelope.decision }
    if (decision.action === "deny") {
      await setApprovalMetadata(ctx, ApprovalPolicy.metadata(approval, decision, "auto_denied"))
      throw new EnforcementError.PolicyDenied(decision.reason, decision.capabilities, envelope.profileId)
    }

    if (decision.action === "allow") {
      await setApprovalMetadata(ctx, ApprovalPolicy.metadata(approval, decision, "auto_allowed"))
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
          ...(cap.class === "file_external" ? { workspaceBoundary: true, outsideWorkspace: true } : {}),
        },
      })
      if (cap.class === "file_external") rememberApprovedExternalRoots(ctx, patterns)
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
            const profileId = resolveEffectiveProfile(input.agent, topLevelProfile, input.session)
            const workspaceInfo = Instance.workspace
            const interaction = input.session?.interaction
            const interactionMode = interaction?.mode === "unattended" ? "unattended" : "attended"
            return ControlProfileCompiler.resolve(profileId, {
              workspace: Instance.directory,
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
          } catch (error) {
            if (error instanceof PermissionNext.RejectedError || error instanceof PermissionNext.CorrectedError) {
              await setApprovalMetadata(ctx, ApprovalPolicy.metadata(profile.approval, decision, "user_denied"))
            }
            throw error
          }
        },
      }
      return ctx
    }
  }

  export async function definitions(input: Omit<Input, "processor">): Promise<Definition[]> {
    using _ = log.time("definitions")
    const result: Definition[] = []

    for (const item of await ToolRegistry.tools(input.model.providerID, input.agent)) {
      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters), {
        tool: item.id,
      }) as JSONSchema7
      result.push({
        id: item.id,
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
              let resolveExecution!: (outcome: SessionProcessor.ToolOutcome) => void
              const executionPromise = new Promise<SessionProcessor.ToolOutcome>((r) => {
                resolveExecution = r
              })
              runtimeInput.processor.trackExecution(options.toolCallId, executionPromise)

              try {
                const workspace = Instance.directory
                const workspaceInfo = Instance.workspace
                const interaction = runtimeInput.session?.interaction
                const interactionMode = interaction?.mode === "unattended" ? "unattended" : "attended"
                const topLevelProfile = await cachedTopLevelProfile()
                const profileId = resolveEffectiveProfile(runtimeInput.agent, topLevelProfile, runtimeInput.session)
                const synergyRoot = Global.Path.root
                const gate = await EnforcementGate.create({
                  activeWorkspace: workspace,
                  workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
                  interactionMode,
                  originalCheckout: (workspaceInfo as any)?.originalCheckout,
                  profileId,
                  readRoots: [synergyRoot],
                })

                const envelope = gate.evaluate(item.id, args as Record<string, any>)
                await applyGateApproval(ctx, gate, envelope, item.id, args as Record<string, any>)

                const timeoutCfg = await TimeoutConfig.resolve()
                const toolTimeoutMs = timeoutCfg.toolOverrides[item.id] ?? timeoutCfg.toolDefaultMs
                const combinedAbort = startExecutionBudget(ctx, toolTimeoutMs)
                ctx.abort = combinedAbort
                await markExecutionStarted(runtimeInput, ctx, args as Record<string, any>)
                const toolCtx = { ...ctx, abort: combinedAbort }
                using toolTimer = log.time("tool.execute", { tool: item.id, callID: options.toolCallId })

                // ── Sandbox wrapping for bash ──────────────────────────
                let sandboxWrapper: SandboxExecutionWrapper | undefined
                if (item.id === "bash") {
                  const sandbox = gate.getSandbox()
                  if (sandbox.mode !== "none" && !shouldBypassShellSandbox(ctx)) {
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
                    })
                    if (sandboxWrapper.skipReason && sandbox.fallback === "deny") {
                      throw new Error(`Sandbox required but unavailable: ${sandboxWrapper.skipReason}`)
                    }
                    // Store wrapper in context for bash tool to use
                    ;(toolCtx.extra as any).sandboxWrapper = sandboxWrapper
                    ;(toolCtx.extra as any).sandboxFallback = sandbox.fallback
                  }
                }

                // ── Plugin: tool.execute.before ────────────────────────
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
                const result = await item.execute(args, toolCtx)
                await Plugin.trigger(
                  "tool.execute.after",
                  {
                    tool: item.id,
                    sessionID: ctx.sessionID,
                    callID: ctx.callID,
                  },
                  result,
                )
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
                throw error
              } finally {
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
      const mcpTools = await MCP.tools()
      const mcpToolNames = new Set(Object.keys(mcpTools))
      for (const [key, item] of Object.entries(mcpTools)) {
        const schema = {
          ...((item.inputSchema as JSONSchema7 | undefined) ?? {}),
          type: "object",
          properties:
            (((item.inputSchema as JSONSchema7 | undefined)?.properties ?? {}) as JSONSchema7["properties"]) ?? {},
          additionalProperties: false,
        } satisfies JSONSchema7
        result.push({
          id: key,
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
                let resolveExecution!: (outcome: SessionProcessor.ToolOutcome) => void
                const executionPromise = new Promise<SessionProcessor.ToolOutcome>((r) => {
                  resolveExecution = r
                })
                runtimeInput.processor.trackExecution(opts.toolCallId, executionPromise)

                try {
                  const workspace = Instance.directory
                  const workspaceInfo = Instance.workspace
                  const interaction = runtimeInput.session?.interaction
                  const interactionMode = interaction?.mode === "unattended" ? "unattended" : "attended"
                  const topLevelProfile = await cachedTopLevelProfile()
                  const profileId = resolveEffectiveProfile(runtimeInput.agent, topLevelProfile, runtimeInput.session)
                  const gate = await EnforcementGate.create({
                    activeWorkspace: workspace,
                    workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
                    interactionMode,
                    originalCheckout: (workspaceInfo as any)?.originalCheckout,
                    registeredMcpTools: mcpToolNames,
                    profileId,
                  })
                  const envelope = gate.evaluate(key, args as Record<string, any>)
                  await applyGateApproval(ctx, gate, envelope, key, args as Record<string, any>)

                  const timeoutCfg = await TimeoutConfig.resolve()
                  const toolTimeoutMs = timeoutCfg.toolOverrides[key] ?? timeoutCfg.toolDefaultMs
                  const combinedAbort = startExecutionBudget(ctx, toolTimeoutMs)
                  ctx.abort = combinedAbort
                  await markExecutionStarted(runtimeInput, ctx, args as Record<string, any>)
                  using toolTimer = log.time("tool.execute", { tool: key, callID: opts.toolCallId })

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

                  const result = await execute(args, { ...opts, abortSignal: combinedAbort })

                  await Plugin.trigger(
                    "tool.execute.after",
                    {
                      tool: key,
                      sessionID: ctx.sessionID,
                      callID: opts.toolCallId,
                    },
                    result,
                  )

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
                  throw error
                } finally {
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

    const disabled = PermissionNext.disabled(
      result.map((item) => item.id),
      PermissionNext.merge(input.agent.permission, PermissionNext.sessionRuleset(input.session)),
    )

    return result.filter(
      (item) => !disabled.has(item.id) && input.userTools?.[item.id] !== false && input.userTools?.["*"] !== false,
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
