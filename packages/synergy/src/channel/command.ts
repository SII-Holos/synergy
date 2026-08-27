import z from "zod"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Log } from "../util/log"
import { Session } from "../session"
import { SessionEndpoint } from "../session/endpoint"
import { Provider } from "../provider/provider"
import type { Scope } from "@/scope"
import { externalIdentityHash } from "./identity"
import { BusyError } from "../session/error"
import { ChannelInteraction } from "./interaction"
import { SessionWorkflowService, WorkflowConflictError } from "../session/workflow"
import { WorkflowPromptRegistry } from "../session/workflow-prompt-registry"

export namespace ChannelCommand {
  const log = Log.create({ service: "channel.command" })

  export const Event = {
    Executed: BusEvent.define(
      "channel.command.executed",
      z.object({
        name: z.string(),
        channelType: z.string(),
        accountId: z.string(),
        chatId: z.string(),
        userId: z.string().optional(),
      }),
    ),
  }

  export type Context = {
    channelType: string
    accountId: string
    chatId: string
    chatType?: "dm" | "group"
    chatName?: string
    senderId?: string
    senderName?: string
    scopeKey?: string
    messageId: string
    mentions?: Array<{ key: string; id?: string; name?: string }>
    wasMentioned?: boolean
    remainder: string
  }

  export type Result = { action: "handled"; reply?: string } | { action: "continue"; text: string } | { action: "skip" }

  type CommandDef = {
    name: string
    triggers: string[]
    execute: (ctx: Context, scope: Scope) => Promise<Result>
  }

  function endpointForContext(
    ctx: Pick<
      Context,
      "channelType" | "accountId" | "chatId" | "chatType" | "chatName" | "senderId" | "senderName" | "scopeKey"
    >,
  ) {
    return SessionEndpoint.fromChannel({
      type: ctx.channelType,
      accountId: ctx.accountId,
      chatId: ctx.chatId,
      chatType: ctx.chatType,
      chatName: ctx.chatName,
      senderId: ctx.senderId,
      senderName: ctx.senderName,
      scopeKey: ctx.scopeKey,
      createdAt: Date.now(),
    })
  }

  async function workflowSession(ctx: Context, scope: Scope) {
    return Session.getOrCreateForEndpoint(endpointForContext(ctx), {
      scope,
      interaction: ChannelInteraction.forType(ctx.channelType),
    })
  }

  function workflowFailure(error: unknown): Result {
    if (error instanceof BusyError) {
      return {
        action: "handled",
        reply: "⚠️ Wait for the current response to finish before switching workflows.",
      }
    }
    if (error instanceof WorkflowConflictError) {
      return {
        action: "handled",
        reply: `⚠️ ${error.message} Use /chat first to exit the current workflow.`,
      }
    }
    for (const kind of WorkflowPromptRegistry.kinds()) {
      const conflict = WorkflowPromptRegistry.get(kind)?.workflowConflict?.(error)
      if (conflict) {
        return {
          action: "handled",
          reply: `⚠️ ${conflict.reason} Use /chat first to exit the current workflow.`,
        }
      }
    }
    throw error
  }

  async function setWorkflow(
    ctx: Context,
    input: SessionWorkflowService.SetInput,
    confirmation: string,
    scope: Scope,
  ): Promise<Result> {
    try {
      const session = await workflowSession(ctx, scope)
      const current = session.workflow
      const planAlreadyActive = input.kind === "plan" && current?.kind === "plan"
      if (input.kind === "none" && current?.kind === "lightloop") {
        await SessionWorkflowService.cancelLightloop(session.id)
      } else if (input.kind === "lightloop" && current?.kind === "lightloop") {
        await SessionWorkflowService.updateLightloopInstructions(session.id, input.instructions)
      } else if (!planAlreadyActive) {
        await SessionWorkflowService.set(session.id, input)
      }
    } catch (error) {
      return workflowFailure(error)
    }

    if (ctx.remainder) return { action: "continue", text: ctx.remainder }
    return { action: "handled", reply: confirmation }
  }

  const commands: CommandDef[] = [
    {
      name: "new",
      triggers: ["/new", "/reset", "/重置", "/清空", "/新对话"],
      async execute(ctx, scope) {
        try {
          await Session.archiveForEndpoint(endpointForContext(ctx), { scope, requireIdle: true })
        } catch (error) {
          if (error instanceof BusyError) {
            return {
              action: "handled",
              reply: "⚠️ Wait for the current response to finish before starting a new conversation.",
            }
          }
          throw error
        }
        log.info("session reset", { channelType: ctx.channelType, chatHash: externalIdentityHash(ctx.chatId) })

        if (ctx.remainder) {
          return { action: "continue", text: ctx.remainder }
        }
        return {
          action: "handled",
          reply: "✅ Started a new conversation. Send your next message when ready.",
        }
      },
    },
    {
      name: "chat",
      triggers: ["/chat"],
      execute: (ctx, scope) => setWorkflow(ctx, { kind: "none" }, "✅ Switched to normal chat.", scope),
    },
    {
      name: "blueprint",
      triggers: ["/blueprint", "/plan"],
      execute: (ctx, scope) =>
        setWorkflow(
          ctx,
          { kind: "plan" },
          "✅ Blueprint planning enabled. Send the request you want turned into a Blueprint.",
          scope,
        ),
    },
    {
      name: "lightloop",
      triggers: ["/lightloop"],
      async execute(ctx, scope) {
        if (!ctx.remainder) return { action: "handled", reply: "Usage: /lightloop <task>" }
        return setWorkflow(ctx, { kind: "lightloop", instructions: ctx.remainder }, "✅ Light Loop enabled.", scope)
      },
    },
    {
      name: "lattice",
      triggers: ["/lattice"],
      execute: (ctx, scope) =>
        setWorkflow(
          ctx,
          { kind: "lattice", mode: "auto" },
          "✅ Lattice enabled. Send the goal you want decomposed and executed.",
          scope,
        ),
    },
    {
      name: "status",
      triggers: ["/status", "/状态"],
      async execute(ctx, scope) {
        const session = await Session.findForEndpoint(endpointForContext(ctx), { scope })
        if (!session) {
          return { action: "handled", reply: "📭 No conversation history yet." }
        }

        const msgs = await Session.messages({ sessionID: session.id, limit: 100 })
        const created = new Date(session.time.created).toLocaleString("en-US")
        const updated = new Date(session.time.updated).toLocaleString("en-US")

        const reply = [
          "📊 Conversation status",
          `Messages: ${msgs.length}`,
          `Created: ${created}`,
          `Updated: ${updated}`,
        ].join("\n")

        return { action: "handled", reply }
      },
    },
    {
      name: "model",
      triggers: ["/model"],
      async execute(ctx, scope) {
        const remainder = ctx.remainder
        if (!remainder) {
          return { action: "handled", reply: "Usage: /model <providerID/modelID>" }
        }

        const [providerID, ...rest] = remainder.split("/")
        if (!providerID || rest.length === 0) {
          return {
            action: "handled",
            reply: "Invalid model format. Use: /model providerID/modelID (e.g. /model openai/gpt-4o)",
          }
        }

        const session = await Session.findForEndpoint(endpointForContext(ctx), { scope })
        if (!session) {
          return { action: "handled", reply: "No active conversation. Send a message first." }
        }

        const parsed = Provider.parseModel(remainder)
        await Session.update(session.id, (draft) => {
          draft.modelOverride = parsed
        })

        return { action: "handled", reply: `✅ Model set to ${parsed.providerID}/${parsed.modelID}` }
      },
    },
    {
      name: "help",
      triggers: ["/help", "/commands"],
      async execute() {
        return {
          action: "handled",
          reply: [
            "Available commands:",
            "/chat [message] — use normal chat for this conversation",
            "/blueprint [request] (/plan) — use Plan to author a Blueprint",
            "/lightloop <task> — keep working until the task passes independent review",
            "/lattice [goal] — decompose and execute a larger goal",
            "/model <providerID/modelID> — change the model for this conversation",
            "/new — start a new conversation",
            "/status — show the current conversation status",
            "/help — show this command list",
          ].join("\n"),
        }
      },
    },
  ]

  function stripLeadingMentions(text: string, mentions?: Context["mentions"]): string {
    const trimmed = text.trim()
    if (!trimmed) return trimmed

    let result = trimmed
    const sortedMentions = [...(mentions ?? [])]
      .map((mention) => `@${mention.name}`.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)

    while (true) {
      const next = result.trimStart()
      const matched = sortedMentions.find((mention) => next.toLowerCase().startsWith(mention.toLowerCase()))
      if (!matched) return result.trim()
      result = next.slice(matched.length).trimStart()
    }
  }

  function parse(
    text: string,
    ctx?: Pick<Context, "mentions" | "wasMentioned">,
  ): { command: CommandDef; remainder: string } | null {
    const candidates = [text.trim()]
    if (ctx?.wasMentioned) {
      const stripped = stripLeadingMentions(text, ctx.mentions)
      if (stripped && stripped !== candidates[0]) candidates.push(stripped)
    }

    for (const candidate of candidates) {
      const lower = candidate.toLowerCase()
      for (const cmd of commands) {
        for (const trigger of cmd.triggers) {
          const triggerLower = trigger.toLowerCase()
          if (lower === triggerLower || lower.startsWith(triggerLower + " ")) {
            const remainder = candidate.slice(trigger.length).trim()
            return { command: cmd, remainder }
          }
        }
      }
    }

    return null
  }

  export async function execute(text: string, ctx: Omit<Context, "remainder">, scope: Scope): Promise<Result> {
    const parsed = parse(text, ctx)

    if (!parsed) return { action: "skip" }

    const result = await parsed.command.execute(
      {
        ...ctx,
        remainder: parsed.remainder,
      },
      scope,
    )

    Bus.publish(Event.Executed, {
      name: parsed.command.name,
      channelType: ctx.channelType,
      accountId: ctx.accountId,
      chatId: ctx.chatId,
      userId: ctx.senderId,
    })

    log.info("command executed", { name: parsed.command.name, action: result.action })
    return result
  }
}
