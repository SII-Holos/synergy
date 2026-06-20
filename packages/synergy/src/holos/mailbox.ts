import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Log } from "@/util/log"

const log = Log.create({ service: "holos.mailbox" })

export namespace Mailbox {
  export interface Message {
    id: string
    contactId: string
    text: string
    direction: "inbound" | "outbound"
    status?: "sent" | "delivered" | "failed"
    errorReason?: string
    timestamp: number
    replyToMessageId?: string
    source?: string
  }

  export async function receive(input: {
    fromId: string
    text: string
    messageId?: string
    source?: string
    replyToMessageId?: string
  }): Promise<Message> {
    const msg: Message = {
      id: input.messageId ?? crypto.randomUUID(),
      contactId: input.fromId,
      text: input.text,
      direction: "inbound",
      timestamp: Date.now(),
      source: input.source,
      replyToMessageId: input.replyToMessageId,
    }
    await Storage.write(StoragePath.holosMailboxInboxItem(input.fromId, msg.id), msg)
    return msg
  }

  export async function send(input: {
    toId: string
    text: string
    replyToMessageId?: string
  }): Promise<Message & { sent: boolean; reason?: string }> {
    const msgId = crypto.randomUUID()
    const msg: Message = {
      id: msgId,
      contactId: input.toId,
      text: input.text,
      direction: "outbound",
      status: "sent",
      timestamp: Date.now(),
      replyToMessageId: input.replyToMessageId,
    }
    await Storage.write(StoragePath.holosMailboxOutboxItem(input.toId, msgId), msg)

    const { HolosRuntime } = await import("./runtime")
    const provider = await HolosRuntime.getProvider()
    if (!provider) {
      const failed: Message = { ...msg, status: "failed", errorReason: "no_provider" }
      await Storage.write(StoragePath.holosMailboxOutboxItem(input.toId, msgId), failed)
      return { ...failed, sent: false, reason: "no_provider" }
    }

    const result = await provider.send(input.toId, "chat.message", {
      text: input.text,
      messageId: msgId,
      replyTo: input.replyToMessageId,
    })

    if (result.sent) {
      const delivered: Message = { ...msg, status: "delivered" }
      await Storage.write(StoragePath.holosMailboxOutboxItem(input.toId, msgId), delivered)
      return { ...delivered, sent: true }
    }

    const failed: Message = { ...msg, status: "failed", errorReason: result.reason }
    await Storage.write(StoragePath.holosMailboxOutboxItem(input.toId, msgId), failed)
    return { ...failed, sent: false, reason: result.reason }
  }

  export async function list(mailbox: "inbox" | "outbox"): Promise<Message[]> {
    const root = mailbox === "inbox" ? ["holos", "mailbox", "inbox"] : ["holos", "mailbox", "outbox"]
    const keys = await Storage.list(root)
    if (keys.length === 0) return []

    const messages: Message[] = []
    for (const key of keys) {
      try {
        const msg = await Storage.read<Message>(key)
        if (msg) messages.push(msg)
      } catch {
        log.warn("mailbox list: failed to read message", { key: key.join("/") })
        continue
      }
    }
    messages.sort((a, b) => b.timestamp - a.timestamp)
    return messages
  }

  export async function listContacts(mailbox: "inbox" | "outbox"): Promise<string[]> {
    const root = mailbox === "inbox" ? ["holos", "mailbox", "inbox"] : ["holos", "mailbox", "outbox"]
    return Storage.scan(root)
  }

  export async function getThread(contactId: string): Promise<Message[]> {
    const inboxKeys = await Storage.list(StoragePath.holosMailboxInboxRoot(contactId))
    const outboxKeys = await Storage.list(StoragePath.holosMailboxOutboxRoot(contactId))
    const allKeys = [...inboxKeys, ...outboxKeys]
    if (allKeys.length === 0) return []

    const messages: Message[] = []
    for (const key of allKeys) {
      try {
        const msg = await Storage.read<Message>(key)
        if (msg) messages.push(msg)
      } catch {
        log.warn("mailbox getThread: failed to read message", { key: key.join("/") })
        continue
      }
    }
    messages.sort((a, b) => b.timestamp - a.timestamp)
    return messages
  }

  export async function retry(messageId: string): Promise<Message & { sent: boolean; reason?: string }> {
    const outboxKeys = await Storage.list(["holos", "mailbox", "outbox"])
    let foundKey: string[] | null = null
    let msg: Message | null = null

    for (const key of outboxKeys) {
      if (key[key.length - 1] === messageId) {
        foundKey = key
        try {
          const read = await Storage.read<Message>(key)
          if (read) msg = read
        } catch {
          continue
        }
        break
      }
    }

    if (!foundKey || !msg) {
      throw new Error(`Message ${messageId} not found in outbox`)
    }

    if (msg.direction !== "outbound") {
      throw new Error(`Message ${messageId} is not an outbound message`)
    }

    const { HolosRuntime } = await import("./runtime")
    const provider = await HolosRuntime.getProvider()
    if (!provider) {
      const failed: Message = { ...msg, status: "failed", errorReason: "no_provider" }
      await Storage.write(foundKey, failed)
      return { ...failed, sent: false, reason: "no_provider" }
    }

    const result = await provider.send(msg.contactId, "chat.message", {
      text: msg.text,
      messageId: msg.id,
      replyTo: msg.replyToMessageId,
    })

    if (result.sent) {
      const { errorReason: _, ...rest } = msg
      const delivered: Message = { ...rest, status: "delivered" }
      await Storage.write(foundKey, delivered)
      return { ...delivered, sent: true }
    }

    const failed: Message = { ...msg, status: "failed", errorReason: result.reason }
    await Storage.write(foundKey, failed)
    return { ...failed, sent: false, reason: result.reason }
  }

  export async function remove(messageId: string): Promise<void> {
    const inboxKeys = await Storage.list(["holos", "mailbox", "inbox"])
    for (const key of inboxKeys) {
      if (key[key.length - 1] === messageId) {
        await Storage.remove(key)
        return
      }
    }

    const outboxKeys = await Storage.list(["holos", "mailbox", "outbox"])
    for (const key of outboxKeys) {
      if (key[key.length - 1] === messageId) {
        await Storage.remove(key)
        return
      }
    }
  }

  export async function removeThread(contactId: string): Promise<void> {
    await Storage.removeTree(StoragePath.holosMailboxInboxRoot(contactId))
    await Storage.removeTree(StoragePath.holosMailboxOutboxRoot(contactId))
  }
}
