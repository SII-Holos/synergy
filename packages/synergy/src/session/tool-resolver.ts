import { type Tool as AITool, tool, jsonSchema, type ToolCallOptions } from "ai"
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
import { Session } from "."
import type { Info } from "./types"
import type { MessageV2 } from "./message-v2"
import type { SessionProcessor } from "./processor"

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

  export async function resolve(input: Input): Promise<Record<string, AITool>> {
    using _ = log.time("resolve")
    const tools: Record<string, AITool> = {}

    const context = (args: any, options: ToolCallOptions): Tool.Context => ({
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

    for (const item of await ToolRegistry.tools(input.model.providerID, input.agent)) {
      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters), { tool: item.id })
      tools[item.id] = tool({
        id: item.id as any,
        description: item.description,
        inputSchema: jsonSchema(schema as any),
        async execute(args, options) {
          const ctx = context(args, options)
          let resolveExecution!: (outcome: SessionProcessor.ToolOutcome) => void
          const executionPromise = new Promise<SessionProcessor.ToolOutcome>((r) => {
            resolveExecution = r
          })
          input.processor.trackExecution(options.toolCallId, executionPromise)

          try {
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
            const result = await item.execute(args, ctx)
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
    }

    if (input.includeMCP !== false) {
      for (const [key, item] of Object.entries(await MCP.tools())) {
        const execute = item.execute
        if (!execute) continue

        item.execute = async (args, opts) => {
          const ctx = context(args, opts)
          let resolveExecution!: (outcome: SessionProcessor.ToolOutcome) => void
          const executionPromise = new Promise<SessionProcessor.ToolOutcome>((r) => {
            resolveExecution = r
          })
          input.processor.trackExecution(opts.toolCallId, executionPromise)

          try {
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

            await ctx.ask({
              permission: key,
              metadata: {},
              patterns: ["*"],
            })

            const result = await execute(args, opts)

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
                  sessionID: input.sessionID,
                  messageID: input.processor.message.id,
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
            resolveExecution({
              status: "error",
              input: args,
              error: (error as any).toString(),
            })
            throw error
          }
        }
        item.toModelOutput = (result) => {
          return {
            type: "text",
            value: result.output,
          }
        }
        tools[key] = item
      }
    }

    // Apply permission filtering: disabled by agent permission + user tool toggles
    const disabled = PermissionNext.disabled(
      Object.keys(tools),
      PermissionNext.merge(input.agent.permission, PermissionNext.sessionRuleset(input.session)),
    )

    for (const id of Object.keys(tools)) {
      if (disabled.has(id) || input.userTools?.[id] === false || input.userTools?.["*"] === false) {
        delete tools[id]
      }
    }

    return tools
  }
}
