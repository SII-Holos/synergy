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
import { fn } from "@/util/fn"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import type { InvokeInput } from "./input"
import type { Info } from "./types"
import type { SessionManager } from "./manager"

export namespace SessionInbox {
  const log = Log.create({ service: "session.inbox" })

  export const ItemMode = z.enum(["task", "steer", "context"])
  export type ItemMode = z.infer<typeof ItemMode>

  // Keep legacy fields for backward compat reads from storage
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

  /** Payload parts — stored without messageID/sessionID like InvokeInput.parts */
  const PayloadTextPart = MessageV2.TextPart.omit({ messageID: true, sessionID: true }).partial({ id: true })
  const PayloadAttachmentPart = MessageV2.AttachmentPart.omit({ messageID: true, sessionID: true }).partial({
    id: true,
  })
  const PayloadPart = z.discriminatedUnion("type", [PayloadTextPart, PayloadAttachmentPart])

  export const Item = z
    .object({
      id: Identifier.schema("inbox"),
      sessionID: Identifier.schema("session"),
      // Legacy fields — kept for compat reads from storage
      kind: ItemKind,
      state: ItemState,
      deliveryTarget: DeliveryTarget,
      // New mode field
      mode: ItemMode,
      // Payload for materialization
      message: z
        .object({
          role: z.enum(["user", "assistant"]).default("user"),
          parts: z.array(PayloadPart),
          agent: z.string().optional(),
          model: z
            .object({
              providerID: z.string(),
              modelID: z.string(),
            })
            .optional(),
          origin: MessageV2.OriginUser.optional(),
          visible: z.boolean().default(true),
        })
        .optional(),
      summaryPreview: z.string().optional(),
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
      messageID: Identifier.schema("message"),
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

  export namespace Deliver {
    export const Input = z.object({
      sessionID: Identifier.schema("session"),
      mode: z.enum(["task", "steer", "context"]),
      message: z.object({
        parts: z.array(PayloadPart),
        role: z.enum(["user", "assistant"]).default("user"),
        agent: z.string().optional(),
        model: z
          .object({
            providerID: z.string(),
            modelID: z.string(),
          })
          .optional(),
        origin: MessageV2.OriginUser.optional(),
        visible: z.boolean().default(true),
      }),
    })
    export const Output = z.object({
      itemID: Identifier.schema("inbox"),
      messageID: Identifier.schema("message"),
    })
  }

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
      mode: item.mode ?? modeFromLegacy(item.kind, item.state, item.deliveryTarget),
      message: item.message,
      summaryPreview: item.summaryPreview,
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

  function summarizeParts(parts: Array<{ type: string; text?: unknown; filename?: unknown }>): Item["summary"] & {
    detail: Item["detail"]
  } {
    const text = parts
      .map((part) => {
        if (part.type !== "text") return ""
        return typeof part.text === "string" ? part.text : ""
      })
      .join("\n")
      .trim()
    const attachments = parts
      .filter((part) => part.type !== "text")
      .map((part) => {
        const filename = part.filename
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

  /** Compatibility: derive mode from legacy kind/state/deliveryTarget */
  export function modeFromLegacy(kind: string, state: string, deliveryTarget: string): ItemMode {
    if (kind === "queued_user" && state === "queued") return "task"
    if (kind === "guiding" || state === "guiding") return "steer"
    if (kind === "agent_update") return "steer"
    return "task"
  }

  export async function list(sessionID: string): Promise<Item[]> {
    return (await listStored(sessionID)).map(publicItem)
  }

  export async function getStored(sessionID: string, itemID: string): Promise<StoredItem> {
    const session = await readSession(sessionID)
    const scopeID = Identifier.asScopeID((session.scope as Scope).id)
    return Storage.read<StoredItem>(StoragePath.sessionInboxItem(scopeID, Identifier.asSessionID(sessionID), itemID))
  }

  /**
   * Deliver a new inbox item with the given mode.
   * Pre-allocates messageID for idempotent materialization.
   */
  export const deliver = fn(Deliver.Input, async (input) => {
    const messageID = Identifier.ascending("message")
    const itemID = Identifier.ascending("inbox")
    const summarized = summarizeParts(input.message.parts)
    const mode = input.mode
    const kind = mode === "task" ? "queued_user" : mode === "steer" ? "guiding" : "agent_update"
    const state = mode === "task" ? "queued" : "guiding"
    const deliveryTarget = mode === "steer" || mode === "context" ? "next_model_call" : "after_turn"
    const source: ItemSource = input.message.agent
      ? { type: "agent", label: input.message.agent }
      : { type: "user", label: "You" }
    const item: StoredItem = {
      id: itemID,
      sessionID: input.sessionID,
      kind: kind as StoredItem["kind"],
      state: state as StoredItem["state"],
      deliveryTarget: deliveryTarget as StoredItem["deliveryTarget"],
      mode,
      message: {
        parts: input.message.parts as any,
        role: input.message.role,
        agent: input.message.agent,
        model: input.message.model,
        origin: input.message.origin,
        visible: input.message.visible,
      },
      summaryPreview: summarized.preview,
      summary: {
        title: summarized.title,
        preview: summarized.preview,
      },
      detail: summarized.detail,
      source,
      time: { created: Date.now() },
      orderKey: itemID,
      messageID,
    }
    await writeItem(item)
    return { itemID, messageID }
  })

  export async function enqueueUser(input: InvokeInput): Promise<Item> {
    const itemID = Identifier.ascending("inbox")
    const messageID = Identifier.ascending("message")
    const { messageID: _queuedMessageID, ...queuedInput } = input
    const summarized = summarizeParts(input.parts)
    const item: StoredItem = {
      id: itemID,
      sessionID: input.sessionID,
      kind: "queued_user",
      state: "queued",
      deliveryTarget: "after_turn",
      mode: "task",
      message: {
        role: "user",
        parts: input.parts as any,
        agent: input.agent,
        model: input.model,
        visible: true,
      },
      summaryPreview: summarized.preview,
      summary: {
        title: "Queued by you",
        preview: summarized.preview,
      },
      detail: summarized.detail,
      source: { type: "user", label: "You" },
      time: { created: Date.now() },
      orderKey: itemID,
      messageID,
      input: queuedInput,
    }
    return publicItem(await writeItem(item))
  }

  export async function enqueueMail(input: { sessionID: string; mail: SessionManager.SessionMail }): Promise<Item> {
    const itemID = Identifier.ascending("inbox")
    const messageID = Identifier.ascending("message")
    const summarized = summarizeParts(input.mail.parts)
    const mailMetadata = input.mail.metadata ?? {}
    const mailSourceLabel = mailMetadata.source
    const source: ItemSource =
      mailSourceLabel === "cortex"
        ? { type: "cortex", label: "Cortex" }
        : mailSourceLabel === "agenda"
          ? { type: "agenda", label: "Agenda" }
          : mailSourceLabel === "blueprint"
            ? { type: "blueprint", label: "Blueprint" }
            : mailMetadata.channelPush
              ? { type: "channel", label: "Channel" }
              : typeof mailSourceLabel === "string" && mailSourceLabel.trim()
                ? { type: mailSourceLabel, label: mailSourceLabel }
                : { type: "agent", label: "Agent" }
    const title = input.mail.type === "user" ? input.mail.summary?.title : undefined
    const userMail = input.mail as SessionManager.SessionMail.User
    const item: StoredItem = {
      id: itemID,
      sessionID: input.sessionID,
      kind: "agent_update",
      state: "queued",
      deliveryTarget: "after_turn",
      mode: "steer",
      message: {
        role: "user",
        parts: input.mail.parts as any,
        agent: userMail.agent,
        model: userMail.model,
        visible: true,
      },
      summaryPreview: summarized.preview,
      summary: {
        title: title ?? source.label ?? "Agent update",
        preview: summarized.preview,
      },
      detail: summarized.detail,
      source,
      time: { created: Date.now() },
      orderKey: itemID,
      messageID,
      mail: input.mail,
    }
    return publicItem(await writeItem(item))
  }

  /**
   * Guide: flip mode task↔steer.
   * A task item becomes steer (joins next model call).
   * A steer item becomes task (queues for after-turn).
   */
  export async function guide(input: { sessionID: string; itemID: string }): Promise<Item> {
    const item = await getStored(input.sessionID, input.itemID)
    const newMode: ItemMode = item.mode === "task" ? "steer" : "task"
    const kind = newMode === "task" ? "queued_user" : "guiding"
    const state = newMode === "task" ? "queued" : "guiding"
    const deliveryTarget = newMode === "steer" ? "next_model_call" : "after_turn"
    const updated: StoredItem = {
      ...item,
      kind: kind as StoredItem["kind"],
      state: state as StoredItem["state"],
      deliveryTarget: deliveryTarget as StoredItem["deliveryTarget"],
      mode: newMode,
      time: {
        ...item.time,
        updated: Date.now(),
      },
    }
    return publicItem(await writeItem(updated))
  }

  /**
   * Remove any inbox item (not just queued_user).
   */
  export async function remove(input: { sessionID: string; itemID: string }): Promise<void> {
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

  /**
   * Drain agent-update inbox items (e.g. cortex background-task completion
   * notifications).  Unlike {@link drainReady}, this is designed for mid-turn
   * injection — callers should materialize with `{ guiding: true }` so the
   * update is injected into the running conversation without triggering a
   * redundant reply cycle.
   */
  export async function drainAgentUpdates(sessionID: string): Promise<StoredItem[]> {
    return drainWhere(sessionID, (item) => item.kind === "agent_update")
  }

  export async function drainReady(sessionID: string): Promise<StoredItem[]> {
    return drainWhere(
      sessionID,
      (item) => item.kind === "queued_user" || item.kind === "guiding" || item.kind === "agent_update",
    )
  }

  /**
   * Peek ready inbox items without deleting them from storage.
   * Used by the session loop's after-turn boundary so items are only
   * committed after the full reply cycle succeeds.
   */
  export async function peekReady(sessionID: string, excludeIDs?: Set<string>): Promise<StoredItem[]> {
    const items = await listStored(sessionID)
    const ready = items.filter(
      (item) =>
        (item.kind === "queued_user" || item.kind === "guiding" || item.kind === "agent_update") &&
        (!excludeIDs || !excludeIDs.has(item.id)),
    )
    return sortItems(ready)
  }

  /**
   * Commit (delete) inbox items after they have been successfully
   * materialized into the session and the reply cycle has completed.
   */
  export async function commitReady(sessionID: string, itemIDs: Iterable<string>): Promise<void> {
    const ids = Array.from(itemIDs)
    await removeItems(sessionID, ids)
  }

  // --- Mode-based drain helpers (Commit 2) ---

  export async function drainSteer(sessionID: string): Promise<StoredItem[]> {
    return drainWhere(sessionID, (item) => item.mode === "steer")
  }

  export async function drainContext(sessionID: string): Promise<StoredItem[]> {
    return drainWhere(sessionID, (item) => item.mode === "context" && item.message?.role === "user")
  }

  /**
   * Drain the next task item from the inbox.
   * Materialization is idempotent (pre-allocated messageID), so removing
   * the inbox item before materialization is safe for crash recovery.
   */
  export async function nextTask(sessionID: string): Promise<StoredItem | undefined> {
    const items = await listStored(sessionID)
    const task = items.find((item) => item.mode === "task")
    if (!task) return undefined
    await removeItems(sessionID, [task.id])
    log.info("drained next task", { sessionID, itemID: task.id })
    return task
  }

  export async function removeByMode(sessionID: string, modes: ItemMode[]): Promise<void> {
    const items = await listStored(sessionID)
    const ids = items.filter((item) => modes.includes(item.mode)).map((item) => item.id)
    if (ids.length === 0) return
    await removeItems(sessionID, ids)
  }

  // --- Idempotent materialization (Commit 2) ---

  export async function materializeItem(
    item: StoredItem,
    rootID?: string,
    options?: { guiding?: boolean },
  ): Promise<MessageV2.WithParts | undefined> {
    // Pre-allocated messageID ensures idempotent write
    const existing = (await Session.messages({ sessionID: item.sessionID })).find((m) => m.info.id === item.messageID)
    if (existing) return existing

    const payload = item.message
    if (!payload) return undefined

    const messageID = item.messageID
    const isRoot = item.mode === "task"
    const resolvedRootID = rootID ?? (isRoot ? messageID : undefined)
    const noReply = options?.guiding !== false ? item.mode === "steer" || item.mode === "context" : false

    const role = payload.role
    const agent = payload.agent ?? "system"
    const model = payload.model ?? { providerID: "system", modelID: "fallback" }

    // Build parts with synthesized IDs
    const parts = payload.parts.map((p: any) => ({
      ...p,
      id: p.id ?? Identifier.ascending("part"),
      messageID,
      sessionID: item.sessionID,
    }))

    if (role === "user") {
      const info: MessageV2.User = {
        id: messageID,
        role: "user",
        sessionID: item.sessionID,
        time: { created: Date.now() },
        agent,
        model,
        isRoot,
        ...(resolvedRootID ? { rootID: resolvedRootID } : {}),
        visible: payload.visible,
        ...(payload.origin ? { origin: payload.origin } : {}),
        ...(noReply || options?.guiding
          ? {
              metadata: {
                noReply: noReply || undefined,
                guided: options?.guiding || undefined,
              },
            }
          : {}),
      }
      await Session.updateMessage(info)
      for (const part of parts) {
        await Session.updatePart(part)
      }
      return { info, parts }
    }

    // Assistant messages
    const info: MessageV2.Assistant = {
      id: messageID,
      role: "assistant",
      sessionID: item.sessionID,
      parentID: rootID ?? messageID,
      rootID: rootID ?? messageID,
      time: { created: Date.now(), completed: Date.now() },
      agent,
      mode: agent,
      finish: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      path: { cwd: "/", root: "/" },
      modelID: model.modelID,
      providerID: model.providerID,
      visible: payload.visible,
      ...(payload.origin ? { origin: payload.origin } : {}),
    }
    await Session.updateMessage(info)
    for (const part of parts) {
      await Session.updatePart(part)
    }
    return { info, parts }
  }
}
