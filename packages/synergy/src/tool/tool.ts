import z from "zod"
import type { MessageV2 } from "../session/message-v2"
import type { Agent } from "../agent/agent"
import type { PermissionNext } from "../permission/next"
import { Truncate } from "./truncation"
import { ToolExposure } from "./exposure"
import type { ToolDisplay } from "@ericsanchezok/synergy-plugin/tool"
import type { PluginJsonSchema, PluginSettingCondition } from "@ericsanchezok/synergy-plugin"

export namespace Tool {
  interface Metadata {
    [key: string]: any
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
    extra?: { [key: string]: any }
    metadata(input: { title?: string; metadata?: M }): void
    ask(input: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">): Promise<void>
  }
  export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
    id: string
    exposure?: ToolExposure.Info
    display?: ToolDisplay
    source?: Source
    inputSchema?: PluginJsonSchema
    enabledWhen?: PluginSettingCondition
    init: (ctx?: InitContext) => Promise<{
      description: string
      parameters: Parameters
      execute(
        args: z.infer<Parameters>,
        ctx: Context,
      ): Promise<{
        title: string
        metadata: M
        output: string
        attachments?: MessageV2.AttachmentPart[]
      }>
      formatValidationError?(error: z.ZodError): string
    }>
  }

  export type InferParameters<T extends Info> = T extends Info<infer P> ? z.infer<P> : never
  export type InferMetadata<T extends Info> = T extends Info<any, infer M> ? M : never

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
      exposure?: ToolExposure.Info
      display?: ToolDisplay
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
      exposure: options?.exposure,
      display: options?.display,
      init: async (initCtx) => {
        const toolInfo = init instanceof Function ? await init(initCtx) : init
        const execute = originalExecute ?? toolInfo.execute
        toolInfo.execute = async (args, ctx) => {
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
          const result = await execute(parsed, ctx)
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
