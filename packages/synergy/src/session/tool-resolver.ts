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
import { EnforcementGate } from "@/enforcement/gate"
import { SandboxBackend } from "@/sandbox/backend"
import type { SandboxExecutionWrapper } from "@/sandbox/backend"
import type { ProfileId } from "@/control-profile/types"
import { Config } from "@/config/config"

export namespace ToolResolver {
  const log = Log.create({ service: "tool.resolver" })

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
   *   1. agent config controlProfile
   *   2. top-level config controlProfile
   *   3. default 'workspace'
   */
  function resolveEffectiveProfile(agent: Agent.Info, topLevelProfile?: string): ProfileId {
    const VALID: readonly string[] = ["review", "workspace", "auto_review", "full_access"]
    const candidate = agent.controlProfile ?? topLevelProfile ?? "workspace"
    if (VALID.includes(candidate)) return candidate as ProfileId
    return "workspace"
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
    if (toolName === "agora_join" || toolName === "agora_accept") return (args.directory ?? "") as string
    if (toolName === "look_at" || toolName === "attach") {
      const raw = args.file_path ?? args.filePath ?? ""
      return Array.isArray(raw) ? (raw[0] ?? "") : String(raw)
    }
    return (args.filePath ?? args.path ?? args.pattern ?? "") as string
  }

  function permissionForGateCapability(toolName: string, className: string): string {
    if (className === "file_external") return "external_directory"
    if (className === "shell_destructive") return "bash"
    if (className === "network_request")
      return toolName === "webfetch" || toolName === "websearch" ? toolName : "network_request"
    return className
  }

  function patternsForGateCapability(toolName: string, className: string, args: Record<string, any>): string[] {
    if (className === "file_external") return [externalPathFromArgs(toolName, args) || "*"]
    if (className === "shell_destructive") return [String(args.command ?? "*")]
    if (className === "network_request") return [String(args.url ?? args.query ?? "*")]
    if (className === "communication_email") return [String(args.to ?? args.from ?? args.subject ?? "*")]
    if (className === "identity_act") return [`${toolName} role=${args.role ?? "*"} to ${args.target ?? "*"}`]
    return ["*"]
  }

  async function askGateNonBypassableCapabilities(
    ctx: Tool.Context,
    gate: ReturnType<typeof EnforcementGate.create>,
    envelope: ReturnType<ReturnType<typeof EnforcementGate.create>["evaluate"]>,
    toolName: string,
    args: Record<string, any>,
  ) {
    if (envelope.decision !== "ask") return
    for (const cap of envelope.capabilities) {
      if (!cap.nonBypassable && !cap.opaque) continue
      if (!gate.hasPendingCapability(cap.class)) continue
      // These tools already perform the exact same non-bypassable ask with
      // richer, tool-specific metadata before crossing the boundary.
      if (toolName === "email_send" && cap.class === "communication_email") continue
      if (toolName === "session_send" && cap.class === "identity_act") continue
      if ((toolName === "webfetch" || toolName === "websearch") && cap.class === "network_request") continue
      if (toolName === "email_read" && cap.class === "communication_email") continue

      await ctx.ask({
        permission: permissionForGateCapability(toolName, cap.class),
        patterns: patternsForGateCapability(toolName, cap.class, args),
        metadata: {
          nonBypassable: true,
          capability: cap.class,
          opaque: cap.opaque === true,
          ...(cap.class === "file_external" ? { workspaceBoundary: true, outsideWorkspace: true } : {}),
        },
      })
      gate.resolveCapability(cap.class)
    }
  }

  function contextFactory(input: Input) {
    return (args: any, options: ToolCallOptions): Tool.Context => ({
      sessionID: input.sessionID,
      abort: options.abortSignal!,
      messageID: input.processor.message.id,
      callID: options.toolCallId,
      extra: { model: input.model },
      agent: input.agent.name,
      metadata: async (val: { title?: string; metadata?: any }) => {
        const match = input.processor.partFromToolCall(options.toolCallId)
        if (match && match.state.status === "running") {
          await Session.updatePart({
            ...match,
            state: {
              title: val.title,
              metadata: val.metadata,
              status: "running",
              input: args,
              time: {
                start: Date.now(),
              },
            },
          })
        }
      },
      async ask(req) {
        await PermissionNext.ask({
          ...req,
          sessionID: input.sessionID,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          metadata: {
            ...req.metadata,
            ...PermissionNext.requestMetadata(input.session),
          },
          ruleset: PermissionNext.merge(input.agent.permission, PermissionNext.sessionRuleset(input.session)),
        })
      },
    })
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
              using toolTimer = log.time("tool.execute", { tool: item.id, callID: options.toolCallId })
              let resolveExecution!: (outcome: SessionProcessor.ToolOutcome) => void
              const executionPromise = new Promise<SessionProcessor.ToolOutcome>((r) => {
                resolveExecution = r
              })
              runtimeInput.processor.trackExecution(options.toolCallId, executionPromise)

              const timeoutCfg = await TimeoutConfig.resolve()
              const toolTimeoutMs = timeoutCfg.toolOverrides[item.id] ?? timeoutCfg.toolDefaultMs
              const toolDeadline = AbortSignal.timeout(toolTimeoutMs)
              const combinedAbort = options.abortSignal
                ? AbortSignal.any([options.abortSignal, toolDeadline])
                : toolDeadline
              const toolCtx = { ...ctx, abort: combinedAbort }

              try {
                const workspace = Instance.directory
                const workspaceInfo = Instance.workspace
                const interaction = runtimeInput.session?.interaction
                const interactionMode = interaction?.mode === "unattended" ? "unattended" : "attended"
                const topLevelProfile = await cachedTopLevelProfile()
                const profileId = resolveEffectiveProfile(runtimeInput.agent, topLevelProfile)
                const gate = EnforcementGate.create({
                  activeWorkspace: workspace,
                  workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
                  interactionMode,
                  originalCheckout: (workspaceInfo as any)?.originalCheckout,
                  profileId,
                })

                const envelope = gate.evaluate(item.id, args as Record<string, any>)
                if (envelope.decision === "deny") {
                  throw new Error(`Enforcement gate denied ${item.id}`)
                }

                await askGateNonBypassableCapabilities(ctx, gate, envelope, item.id, args as Record<string, any>)

                // ── Sandbox wrapping for bash ──────────────────────────
                let sandboxWrapper: SandboxExecutionWrapper | undefined
                if (item.id === "bash") {
                  const sandbox = gate.getSandbox()
                  if (sandbox.mode !== "none") {
                    const bashCommand = ((args as Record<string, any>)?.command as string) ?? ""
                    sandboxWrapper = SandboxBackend.prepareWrapper({
                      command: "/bin/sh",
                      args: ["-c", bashCommand],
                      workspace,
                      sandboxMode: sandbox.mode,
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
                    metadata: result.metadata ?? {},
                    attachments: result.attachments,
                  },
                })
                return result
              } catch (error) {
                log.error("tool.execute.error", {
                  tool: item.id,
                  sessionID: ctx.sessionID,
                  callID: options.toolCallId,
                  error,
                })
                resolveExecution({
                  status: "error",
                  input: args,
                  error: (error as any).toString(),
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
                using toolTimer = log.time("tool.execute", { tool: key, callID: opts.toolCallId })
                let resolveExecution!: (outcome: SessionProcessor.ToolOutcome) => void
                const executionPromise = new Promise<SessionProcessor.ToolOutcome>((r) => {
                  resolveExecution = r
                })
                runtimeInput.processor.trackExecution(opts.toolCallId, executionPromise)

                const timeoutCfg = await TimeoutConfig.resolve()
                const toolTimeoutMs = timeoutCfg.toolOverrides[key] ?? timeoutCfg.toolDefaultMs
                const toolDeadline = AbortSignal.timeout(toolTimeoutMs)
                const combinedAbort = opts.abortSignal
                  ? AbortSignal.any([opts.abortSignal, toolDeadline])
                  : toolDeadline

                try {
                  const workspace = Instance.directory
                  const workspaceInfo = Instance.workspace
                  const interaction = runtimeInput.session?.interaction
                  const interactionMode = interaction?.mode === "unattended" ? "unattended" : "attended"
                  const topLevelProfile = await cachedTopLevelProfile()
                  const profileId = resolveEffectiveProfile(runtimeInput.agent, topLevelProfile)
                  const gate = EnforcementGate.create({
                    activeWorkspace: workspace,
                    workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
                    interactionMode,
                    originalCheckout: (workspaceInfo as any)?.originalCheckout,
                    registeredMcpTools: mcpToolNames,
                    profileId,
                  })
                  const envelope = gate.evaluate(key, args as Record<string, any>)
                  if (envelope.decision === "deny") {
                    throw new Error(`Enforcement gate denied ${key}`)
                  }

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

                  await askGateNonBypassableCapabilities(ctx, gate, envelope, key, args as Record<string, any>)

                  await ctx.ask({
                    permission: key,
                    metadata: {},
                    patterns: ["*"],
                  })

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
                      metadata: output.metadata,
                      attachments: output.attachments,
                    },
                  })

                  return output
                } catch (error) {
                  log.error("tool.execute.error", {
                    tool: key,
                    sessionID: ctx.sessionID,
                    callID: opts.toolCallId,
                    error,
                  })
                  resolveExecution({
                    status: "error",
                    input: args,
                    error: (error as any).toString(),
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
