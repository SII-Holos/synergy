import { MigrationRegistry } from "../migration/registry"
import { randomUUID } from "node:crypto"
import { RuntimeContext } from "../lifecycle/context"
import type { ToolActivityEvidence, ToolActivityCapture } from "../session/activity-evidence"
import { EnvironmentResources } from "../environment/resources"
import { WorkspaceState } from "../workspace/state"
import { ScopeContext } from "../scope/context"
import { Scope } from "../scope"
import type { RolloutProcess } from "../session/rollout/process"
import z from "zod"
import type { MessageV2 } from "../session/message-v2"
import type { Agent } from "../agent/agent"
import type { PermissionNext } from "../permission/next"
import { Truncate } from "./truncation"
import { ToolExposure } from "./exposure"
import type { ToolDisplay } from "@ericsanchezok/synergy-util/tool"
import type { SettingCondition as PluginSettingCondition } from "@ericsanchezok/synergy-util/setting-condition"
type PluginJsonSchema = Record<string, unknown>

export namespace Tool {
  const historyOwners = RuntimeContext.state(() => new Set<string>())
  const histories = RuntimeContext.state(
    () => new Map<string, Readonly<Record<string, string | { name: string; scale: number }>>>(),
  )

  export function registerInputHistory(
    owner: string,
    mappings: Record<string, Readonly<Record<string, string | { name: string; scale: number }>>>,
  ) {
    if (historyOwners().has(owner)) return
    for (const [id, mapping] of Object.entries(mappings)) {
      const existing = histories().get(id)
      if (existing && JSON.stringify(existing) === JSON.stringify(mapping)) continue
      RuntimeContext.assertCompositionOpen("tool input history")
      if (existing) throw new Error(`Tool input history for ${id} is already registered`)
      histories().set(id, Object.freeze({ ...mapping }))
    }
    const tools = new Set(Object.keys(mappings))
    const up = async (progress: (current: number, total: number) => void) => {
      const { migrateToolInputSemantics } = await import("../session/migration")
      await migrateToolInputSemantics(progress, tools)
    }
    MigrationRegistry.register(`tool-input-${owner}`, [
      {
        id: `20261001-${owner}-tool-input-semantics`,
        scope: "session",
        description: "Clarify agent tool fields and retain invocation intent",
        up,
        async upSession(target, progress) {
          const { SessionMigrationTarget } = await import("../migration/session-target")
          return SessionMigrationTarget.provide(target, () => up(progress))
        },
      },
    ])
    historyOwners().add(owner)
  }

  export function upgradeInput(id: string, input: Record<string, unknown>): Record<string, unknown> {
    const upgraded = { ...input }
    for (const [previous, target] of Object.entries(histories().get(id) ?? {})) {
      const current = typeof target === "string" ? target : target.name
      if (!Object.hasOwn(upgraded, previous)) continue
      if (!Object.hasOwn(upgraded, current))
        upgraded[current] =
          typeof target === "object" && typeof upgraded[previous] === "number"
            ? upgraded[previous] * target.scale
            : upgraded[previous]
      delete upgraded[previous]
    }
    return upgraded
  }
  interface Metadata {
    [key: string]: any
  }

  export interface ExecutionResult<M extends Metadata = Metadata> {
    title: string
    metadata: M
    output: string
    activityEvidence?: ToolActivityEvidence
    attachments?: MessageV2.AttachmentPart[]
  }

  export interface InitContext {
    agent?: Agent.Info
  }

  export type Source =
    | {
        type: "plugin"
        pluginId: string
        toolId: string
        pluginDir?: string
        runtimeMode: "inProcess" | "process"
      }
    | {
        type: "local"
      }

  export type Context<M extends Metadata = Metadata> = {
    sessionID: string
    messageID: string
    agent: string
    abort: AbortSignal
    callID?: string
    workBrief?: string
    environmentID?: string | null
    resources?: import("../environment/resources").EnvironmentResources.Resolved
    inputImages?(): Promise<import("../session/rollout/input-images").InputImages.Receipt | undefined>
    captureResult?(result: unknown): Promise<void>
    openProcessEvidence?(id: string): Promise<RolloutProcess.Writer>
    recordActivity?(input: ToolActivityCapture): Promise<ToolActivityEvidence>
    extra?: { [key: string]: any }
    metadata(input: { title?: string; metadata?: M }): void
    ask(input: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">): Promise<void>
  }
  export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
    id: string
    requiresWorkspace?: boolean
    requiresExecution?: "exec" | "pty"
    exposure?: ToolExposure.Info
    display?: ToolDisplay
    source?: Source
    inputSchema?: PluginJsonSchema
    enabledWhen?: PluginSettingCondition
    init: (ctx?: InitContext) => Promise<{
      description: string
      parameters: Parameters
      execute(args: z.infer<Parameters>, ctx: Context): Promise<ExecutionResult<M>>
      afterPersist?(args: z.infer<Parameters>, ctx: Context, result: ExecutionResult<M>): Promise<void> | void
      formatValidationError?(error: z.ZodError): string
    }>
  }

  export type InferParameters<T extends Info> = T extends Info<infer P> ? z.infer<P> : never
  export type InferMetadata<T extends Info> = T extends Info<any, infer M> ? M : never

  export async function withWorkspace<T>(
    required: boolean | undefined,
    ctx: { sessionID?: string; messageID?: string; callID?: string; resources?: EnvironmentResources.Resolved },
    fn: () => Promise<T>,
  ) {
    const resources = ctx.resources
    const run = async () => {
      const selected = resources?.workspace
      if (!required && !selected) return fn()
      const workspace = ScopeContext.current.workspace
      if (!workspace && !selected)
        throw new Scope.WorkspaceRequiredError({
          message: "This tool requires a Workspace.",
          scopeID: ScopeContext.current.scope.id,
        })
      const { WorkspaceRuntime } = await import("../workspace/runtime")
      const execute = () =>
        workspace && (!selected || (selected.id === workspace.id && selected.binding.path === resources?.directory))
          ? WorkspaceRuntime.withUse(ScopeContext.current.scope, workspace, ctx.sessionID, fn)
          : WorkspaceRuntime.ensure(ScopeContext.current.scope, {
              id: selected!.id,
              generation: selected!.binding.generation,
              scopeID: selected!.scopeID,
            }).then(fn)
      return selected
        ? WorkspaceState.provide(
            { id: selected.id, generation: selected.binding.generation, scopeID: selected.scopeID },
            execute,
          )
        : execute()
    }
    return resources
      ? EnvironmentResources.provide(
          resources,
          JSON.stringify([ctx.sessionID, ctx.messageID, ctx.callID || randomUUID()]),
          run,
        )
      : run()
  }

  export function validateAttachmentResult(
    tool: string,
    result: { output: string; attachments?: MessageV2.AttachmentPart[] },
  ): void {
    if (!result.attachments?.length) return
    for (const attachment of result.attachments) {
      if (attachment.type !== "attachment") {
        const type = (attachment as { type?: string }).type ?? "unknown"
        throw new Error(`The ${tool} tool returned an invalid attachment with type "${type}".`)
      }
    }
    if (result.output.trim()) return
    const allSummarized = result.attachments.every((attachment) => {
      const model = attachment.model
      if (!model) return false
      if (model.mode === "summary" || model.mode === "provider-file") return Boolean(model.summary?.trim())
      if (model.mode === "content") return Boolean(model.text?.trim())
      return false
    })
    if (allSummarized) return
    throw new Error(
      `The ${tool} tool returned attachments without model-facing output. Provide a non-empty output or a model summary on every attachment.`,
    )
  }

  export function define<Parameters extends z.ZodType, Result extends Metadata>(
    id: string,
    init: Info<Parameters, Result>["init"] | Awaited<ReturnType<Info<Parameters, Result>["init"]>>,
    options?: {
      requiresWorkspace?: boolean
      requiresExecution?: "exec" | "pty"
      exposure?: ToolExposure.Info
      display?: ToolDisplay
      activityKind?: ToolActivityEvidence["kind"]
    },
  ): Info<Parameters, Result> {
    // When `init` is a plain object (not a factory function), the same object
    // is returned on every init() call. The wrapper below replaces
    // toolInfo.execute each time — but if we read `execute` from the (already
    // mutated) object, we chain wrapper(wrapper(wrapper(…original…))).
    // After ~15 000 init() calls across all sessions the async wrapper chain
    // exceeds the call-stack limit and every tool call throws
    // "RangeError: Maximum call stack size exceeded".
    //
    // Fix: capture the original execute once at define-time so the wrapper
    // always calls it directly — no stacking, no accumulation.
    const originalExecute = init instanceof Function ? undefined : init.execute

    return {
      id,
      requiresWorkspace: options?.requiresWorkspace,
      requiresExecution: options?.requiresExecution,
      exposure: options?.exposure,
      display: options?.display,
      init: async (initCtx) => {
        const toolInfo = { ...(init instanceof Function ? await init(initCtx) : init) }
        const execute = originalExecute ?? toolInfo.execute
        toolInfo.execute = async (args, ctx) => {
          if (options?.requiresWorkspace && !ctx.resources?.workspace && !ScopeContext.current.workspace)
            throw new Scope.WorkspaceRequiredError({
              message: "This tool requires a Workspace.",
              scopeID: ScopeContext.current.scope.id,
            })
          let parsed: typeof args
          try {
            parsed = toolInfo.parameters.parse(args)
          } catch (error) {
            if (error instanceof z.ZodError && toolInfo.formatValidationError) {
              throw new Error(toolInfo.formatValidationError(error), { cause: error })
            }
            throw new Error(
              `The ${id} tool was called with invalid arguments: ${error}.\nPlease rewrite the input so it satisfies the expected schema.`,
              { cause: error },
            )
          }
          const result = await withWorkspace(options?.requiresWorkspace, ctx, () => execute(parsed, ctx))
          if (!result.activityEvidence && options?.activityKind && ctx.recordActivity)
            result.activityEvidence = await ctx.recordActivity({
              kind: options.activityKind,
              text: result.output,
              mediaType: "text/plain",
            })
          await ctx.captureResult?.(result)
          validateAttachmentResult(id, result)
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const truncated = await Truncate.output(result.output, {}, initCtx?.agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }
        return toolInfo
      },
    }
  }
}
