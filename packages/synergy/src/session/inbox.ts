import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Identifier } from "@/id/id"
import { Scope } from "@/scope"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Context } from "@/util/context"
import { Log } from "@/util/log"
import { MessageV2 } from "./message-v2"
import { InvokeInput } from "./input"
import type { Info } from "./types"
import type { SessionManager } from "./manager"

export namespace SessionInbox {
  const log = Log.create({ service: "session.inbox" })

  const ItemKind = z.enum(["queued_user", "guiding", "agent_update"])
  const ItemState = z.enum(["queued", "guiding"])
  const DeliveryTarget = z.enum(["after_turn", "next_model_call"])

  export const ItemSource = z
    .object({
      type: z.string(),
      label: z.string().optional(),
    })
    .passthrough()
    .meta({ ref: "SessionInboxItemSource" })
  export type ItemSource = z.infer<typeof ItemSource>

  export const Item = z
    .object({
      id: Identifier.schema("inbox"),
      sessionID: Identifier.schema("session"),
      kind: ItemKind,
      state: ItemState,
      deliveryTarget: DeliveryTarget,
      summary: z.object({
        title: z.string(),
        preview: z.string().optional(),
      }),
      detail: z
        .object({
          text: z.string().optional(),
          attachments: z.array(z.string()).optional(),
        })
        .optional(),
      source: ItemSource,
      time: z.object({
        created: z.number(),
        updated: z.number().optional(),
      }),
      orderKey: z.string(),
      messageID: Identifier.schema("message").optional(),
    })
    .meta({ ref: "SessionInboxItem" })
  export type Item = z.infer<typeof Item>

  export const InputResult = z
    .discriminatedUnion("status", [
      z.object({
        status: z.literal("started"),
        messageID: Identifier.schema("message"),
      }),
      z.object({
        status: z.literal("queued"),
        item: Item,
      }),
    ])
    .meta({ ref: "SessionInputResult" })
  export type InputResult = z.infer<typeof InputResult>

  export const Event = {
    Updated: BusEvent.define(
      "session.inbox.updated",
      z.object({
        sessionID: Identifier.schema("session"),
        items: Item.array(),
      }),
    ),
  }

  export type StoredItem = Item & {
    input?: InvokeInput
    mail?: SessionManager.SessionMail
  }

  async function readSession(sessionID: string): Promise<Info> {
    const indexed = await Storage.read<{ scopeID: string }>(StoragePath.sessionIndex(Identifier.asSessionID(sessionID)))
    return Storage.read<Info>(
      StoragePath.sessionInfo(Identifier.asScopeID(indexed.scopeID), Identifier.asSessionID(sessionID)),
    )
  }

  function publicItem(item: StoredItem): Item {
    return Item.parse({
      id: item.id,
      sessionID: item.sessionID,
      kind: item.kind,
      state: item.state,
      deliveryTarget: item.deliveryTarget,
      summary: item.summary,
      detail: item.detail,
      source: item.source,
      time: item.time,
      orderKey: item.orderKey,
      messageID: item.messageID,
    })
  }

  function sortItems<T extends { orderKey: string; id: string }>(items: T[]): T[] {
    return items.slice().sort((a, b) => {
      const order = a.orderKey.localeCompare(b.orderKey)
      return order === 0 ? a.id.localeCompare(b.id) : order
    })
  }

  async function listStored(sessionID: string): Promise<StoredItem[]> {
    const session = await readSession(sessionID)
    const scopeID = Identifier.asScopeID((session.scope as Scope).id)
    const sid = Identifier.asSessionID(sessionID)
    const ids = await Storage.scan(StoragePath.sessionInboxRoot(scopeID, sid))
    const keys = ids.map((id) => StoragePath.sessionInboxItem(scopeID, sid, id))
    const items = await Storage.readMany<StoredItem>(keys)
    return sortItems(items.filter((item): item is StoredItem => !!item?.id))
  }

  async function writeItem(item: StoredItem): Promise<StoredItem> {
    const session = await readSession(item.sessionID)
    const scopeID = Identifier.asScopeID((session.scope as Scope).id)
    await Storage.write(StoragePath.sessionInboxItem(scopeID, Identifier.asSessionID(item.sessionID), item.id), item)
    await publish(item.sessionID)
    return item
  }

  async function removeItems(sessionID: string, itemIDs: string[]): Promise<void> {
    if (itemIDs.length === 0) return
    const session = await readSession(sessionID)
    const scopeID = Identifier.asScopeID((session.scope as Scope).id)
    await Promise.all(
      itemIDs.map((id) => Storage.remove(StoragePath.sessionInboxItem(scopeID, Identifier.asSessionID(sessionID), id))),
    )
    await publish(sessionID)
  }

  async function publish(sessionID: string): Promise<void> {
    const items = await list(sessionID)
    const payload = { sessionID, items }
    try {
      await Bus.publish(Event.Updated, payload)
    } catch (e) {
      if (!(e instanceof Context.NotFound)) throw e
      const session = await readSession(sessionID)
      const scope = session.scope as Scope
      GlobalBus.emit("event", {
        directory: scope.type === "home" ? "home" : scope.directory,
        payload: {
          type: Event.Updated.type,
          properties: payload,
        },
      })
    }
  }

  function summarizeParts(parts: Array<Partial<MessageV2.Part> & { type: string }>): Item["summary"] & {
    detail: Item["detail"]
  } {
    const text = parts
      .map((part) => {
        if (part.type !== "text") return ""
        return typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""
      })
      .join("\n")
      .trim()
    const attachments = parts
      .filter((part) => part.type !== "text")
      .map((part) => {
        const filename = (part as { filename?: unknown }).filename
        if (typeof filename === "string" && filename.trim()) return filename
        return part.type
      })
    const preview = text
      ? text.slice(0, 160)
      : attachments.length > 0
        ? attachments.join(", ").slice(0, 160)
        : undefined
    return {
      title: preview || "Pending update",
      preview,
      detail: {
        ...(text ? { text } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    }
  }

  function sourceFromMail(mail: SessionManager.SessionMail): ItemSource {
    const metadata = mail.metadata ?? {}
    const source = metadata.source
    if (source === "cortex") return { type: "cortex", label: "Cortex" }
    if (source === "agenda") return { type: "agenda", label: "Agenda" }
    if (source === "blueprint") return { type: "blueprint", label: "Blueprint" }
    if (metadata.channelPush) return { type: "channel", label: "Channel" }
    if (typeof source === "string" && source.trim()) return { type: source, label: source }
    return { type: "agent", label: "Agent" }
  }

  export async function list(sessionID: string): Promise<Item[]> {
    return (await listStored(sessionID)).map(publicItem)
  }

  export async function getStored(sessionID: string, itemID: string): Promise<StoredItem> {
    const session = await readSession(sessionID)
    const scopeID = Identifier.asScopeID((session.scope as Scope).id)
    return Storage.read<StoredItem>(StoragePath.sessionInboxItem(scopeID, Identifier.asSessionID(sessionID), itemID))
  }

  export async function enqueueUser(input: InvokeInput): Promise<Item> {
    const itemID = Identifier.ascending("inbox")
    const messageID = input.messageID ?? Identifier.ascending("message")
    const summarized = summarizeParts(input.parts)
    const item: StoredItem = {
      id: itemID,
      sessionID: input.sessionID,
      kind: "queued_user",
      state: "queued",
      deliveryTarget: "after_turn",
      summary: {
        title: "Queued by you",
        preview: summarized.preview,
      },
      detail: summarized.detail,
      source: { type: "user", label: "You" },
      time: { created: Date.now() },
      orderKey: itemID,
      messageID,
      input: { ...input, messageID },
    }
    return publicItem(await writeItem(item))
  }

  export async function enqueueMail(input: { sessionID: string; mail: SessionManager.SessionMail }): Promise<Item> {
    const itemID = Identifier.ascending("inbox")
    const summarized = summarizeParts(input.mail.parts)
    const source = sourceFromMail(input.mail)
    const title = input.mail.type === "user" ? input.mail.summary?.title : undefined
    const item: StoredItem = {
      id: itemID,
      sessionID: input.sessionID,
      kind: "agent_update",
      state: "queued",
      deliveryTarget: "after_turn",
      summary: {
        title: title ?? source.label ?? "Agent update",
        preview: summarized.preview,
      },
      detail: summarized.detail,
      source,
      time: { created: Date.now() },
      orderKey: itemID,
      messageID: (input.mail as { messageID?: string }).messageID,
      mail: input.mail,
    }
    return publicItem(await writeItem(item))
  }

  export async function guide(input: { sessionID: string; itemID: string }): Promise<Item> {
    const item = await getStored(input.sessionID, input.itemID)
    if (item.kind !== "queued_user") {
      throw new Error("Only queued user messages can guide the current run")
    }
    const updated: StoredItem = {
      ...item,
      kind: "guiding",
      state: "guiding",
      deliveryTarget: "next_model_call",
      time: {
        ...item.time,
        updated: Date.now(),
      },
    }
    return publicItem(await writeItem(updated))
  }

  export async function remove(input: { sessionID: string; itemID: string }): Promise<void> {
    const item = await getStored(input.sessionID, input.itemID)
    if (item.kind !== "queued_user") {
      throw new Error("Only queued user messages can be removed from the inbox")
    }
    await removeItems(input.sessionID, [input.itemID])
  }

  async function drainWhere(sessionID: string, predicate: (item: StoredItem) => boolean): Promise<StoredItem[]> {
    const items = await listStored(sessionID)
    const drained = items.filter(predicate)
    if (drained.length === 0) return []
    await removeItems(
      sessionID,
      drained.map((item) => item.id),
    )
    log.info("drained inbox items", { sessionID, count: drained.length })
    return drained
  }

  export async function drainGuiding(sessionID: string): Promise<StoredItem[]> {
    return drainWhere(sessionID, (item) => item.kind === "guiding")
  }

  export async function drainReady(sessionID: string): Promise<StoredItem[]> {
    return drainWhere(
      sessionID,
      (item) => item.kind === "queued_user" || item.kind === "guiding" || item.kind === "agent_update",
    )
  }
}
