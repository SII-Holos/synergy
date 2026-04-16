import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "@/session"
import { SessionInteraction } from "@/session/interaction"
import { SessionInvoke } from "@/session/invoke"
import { SessionManager } from "@/session/manager"
import { MessageV2 } from "@/session/message-v2"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Provider } from "@/provider/provider"
import type { Contact } from "./contact"
import { HolosMessageMetadata } from "./message-metadata"

const log = Log.create({ service: "holos.friend-reply" })

const MAX_SUB_SESSIONS = 20
let cleaning = false

export namespace FriendReply {
  export interface ProcessInput {
    friendSessionId: string
    triggerMessageId: string
    contactId: string
    contactName: string
    messageText: string
    contact: Contact.Info
  }

  export async function process(input: ProcessInput): Promise<void> {
    const budget = input.contact.config.maxAutoTurns ?? 10
    const turnCount = await getAutoTurnCount(input.contactId)

    if (turnCount >= budget) {
      log.info("turn budget exceeded, skipping auto-reply", {
        contactId: input.contactId,
        turnCount,
        budget,
      })

      const textPart: MessageV2.TextPart = {
        id: Identifier.ascending("part"),
        sessionID: input.friendSessionId,
        messageID: Identifier.ascending("message"),
        type: "text",
        text: `⚠️ Auto-reply limit reached (${budget} turns). Messages from "${input.contactName}" will no longer receive automatic replies. Send a manual reply to reset the counter.`,
        synthetic: true,
      }
      await SessionManager.deliver({
        target: input.friendSessionId,
        mail: { type: "assistant", parts: [textPart], metadata: { source: "agent" } },
      })

      return
    }

    const context = await buildContext(input)

    const session = await Session.create({
      parentID: input.friendSessionId,
      title: `Reply to ${input.contactName}`,
      interaction: SessionInteraction.unattended("holos:auto-reply"),
    })

    await Storage.write(StoragePath.holosFriendReply(input.friendSessionId, input.triggerMessageId), {
      subSessionId: session.id,
    })

    await incrementAutoTurnCount(input.contactId)

    log.info("friend reply sub-session created", {
      friendSessionId: input.friendSessionId,
      subSessionId: session.id,
      triggerMessageId: input.triggerMessageId,
    })

    const model = (await Provider.resolveRoleModel("holos_friend_reply")) ?? (await Provider.defaultModel())

    await SessionInvoke.invoke({
      sessionID: session.id,
      model,
      parts: [{ type: "text", text: context }],
    })

    cleanOldSubSessions(input.friendSessionId).catch((err: unknown) =>
      log.warn("failed to clean old sub-sessions", { friendSessionId: input.friendSessionId, error: err }),
    )
  }

  async function buildContext(input: ProcessInput): Promise<string> {
    const messages = await Session.messages({ sessionID: input.friendSessionId, limit: 20 })

    const history = messages
      .map((msg) => {
        const text = MessageV2.extractText(msg.parts, { includeSynthetic: false })
        if (!text) return ""
        if (msg.info.role === "user") {
          const metadata = ((msg.info as MessageV2.User).metadata as Record<string, unknown> | undefined) ?? undefined
          const name = HolosMessageMetadata.holos(metadata)?.senderName ?? input.contactName
          return `[${name}]: ${text}`
        }
        const source = (msg.info as MessageV2.Assistant).metadata?.source === "human" ? "Your owner" : "You"
        return `[${source} → ${input.contactName}]: ${text}`
      })
      .filter(Boolean)
      .join("\n")

    return [
      `You are handling a message from your friend "${input.contactName}".`,
      "",
      "## Conversation History",
      history || "(This is the first message)",
      "",
      `Latest message from "${input.contactName}":`,
      input.messageText,
      "",
      "## Instructions",
      `- Decide whether this message needs a reply`,
      `- If a reply is needed, use the session_send tool to send it (target: "${input.contactId}")`,
      `- If no reply is needed (e.g. the other party just said "thanks", "ok", etc.), explain why and do not call the tool`,
    ].join("\n")
  }

  async function getAutoTurnCount(contactId: string): Promise<number> {
    const data = await Storage.read<{ count: number }>(StoragePath.holosAutoTurnCount(contactId)).catch(() => undefined)
    return data?.count ?? 0
  }

  async function incrementAutoTurnCount(contactId: string): Promise<void> {
    const current = await getAutoTurnCount(contactId)
    await Storage.write(StoragePath.holosAutoTurnCount(contactId), { count: current + 1 })
  }

  export async function resetAutoTurnCount(contactId: string): Promise<void> {
    await Storage.write(StoragePath.holosAutoTurnCount(contactId), { count: 0 })
  }

  export async function listSubSessions(
    friendSessionId: string,
  ): Promise<Array<{ triggerMessageId: string; subSessionId: string }>> {
    const keys = await Storage.scan(StoragePath.holosFriendReplyRoot(friendSessionId))
    const results: Array<{ triggerMessageId: string; subSessionId: string }> = []
    for (const triggerMessageId of keys) {
      const data = await Storage.read<{ subSessionId: string }>(
        StoragePath.holosFriendReply(friendSessionId, triggerMessageId),
      ).catch(() => undefined)
      if (data) {
        results.push({ triggerMessageId, subSessionId: data.subSessionId })
      }
    }
    return results
  }

  async function cleanOldSubSessions(friendSessionId: string): Promise<void> {
    if (cleaning) return
    cleaning = true
    try {
      const entries = await listSubSessions(friendSessionId)
      if (entries.length <= MAX_SUB_SESSIONS) return

      entries.sort((a, b) => a.triggerMessageId.localeCompare(b.triggerMessageId))
      const excess = entries.slice(0, entries.length - MAX_SUB_SESSIONS)

      for (const entry of excess) {
        try {
          await Session.remove(entry.subSessionId)
        } catch {}
        await Storage.remove(StoragePath.holosFriendReply(friendSessionId, entry.triggerMessageId))
      }

      log.info("cleaned old friend-reply sub-sessions", {
        friendSessionId,
        removed: excess.length,
        remaining: MAX_SUB_SESSIONS,
      })
    } finally {
      cleaning = false
    }
  }
}
