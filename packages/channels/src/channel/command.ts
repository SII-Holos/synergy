import z from "zod"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionEndpoint } from "@ericsanchezok/synergy-harness/session/endpoint"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import type { Scope } from "@ericsanchezok/synergy-harness/scope"
import { externalIdentityHash } from "@ericsanchezok/synergy-harness/util/identity"
import { BusyError } from "@ericsanchezok/synergy-harness/session/error"
import { ChannelInteraction } from "./interaction"
import {
  SessionWorkflowService as WorkflowSessionService,
  WorkflowConflictError,
} from "@ericsanchezok/synergy-harness/session/workflow"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { SessionExecutionContributions } from "@ericsanchezok/synergy-harness/session/execution-contributions"
import { WorkflowPromptRegistry } from "@ericsanchezok/synergy-harness/session/workflow-prompt-registry"

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

  export type CommandDef = {
    help?: string
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

  export async function changeWorkflow(
    ctx: Context,
    scope: Scope,
    confirmation: string,
    change: (session: Session.Info) => Promise<unknown>,
  ): Promise<Result> {
    try {
      await change(await workflowSession(ctx, scope))
    } catch (error) {
      return workflowFailure(error)
    }
    return ctx.remainder ? { action: "continue", text: ctx.remainder } : { action: "handled", reply: confirmation }
  }

  const contributed = RuntimeContext.state(() => new Map<string, readonly CommandDef[]>())
  export function register(owner: string, additions: readonly CommandDef[]) {
    RuntimeContext.assertCompositionOpen("channel commands")
    if (contributed().has(owner)) throw new Error(`Channel commands already registered: ${owner}`)
    const triggers = new Set(
      [...commands, ...[...contributed().values()].flatMap((items) => [...items])].flatMap((command) =>
        command.triggers.map((trigger) => trigger.toLowerCase()),
      ),
    )
    for (const command of additions)
      for (const trigger of command.triggers) {
        const key = trigger.toLowerCase()
        if (triggers.has(key)) throw new Error(`Channel command already registered: ${trigger}`)
        triggers.add(key)
      }
    contributed().set(owner, additions)
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
      execute: (ctx, scope) =>
        changeWorkflow(ctx, scope, "✅ Switched to normal chat.", async (session) => {
          const abandoned = await SessionExecutionContributions.abandonWorkflow(session)
          if (!abandoned) await WorkflowSessionService.setNone(session.id)
        }),
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
        await Session.setModelSelection(session.id, { model: parsed })

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
            ...[...contributed().values()].flatMap((items) =>
              items.flatMap((command) => (command.help ? [command.help] : [])),
            ),
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
      for (const cmd of [...commands, ...[...contributed().values()].flatMap((items) => [...items])]) {
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
