import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Identifier } from "@/id/id"
import { Scope } from "@/scope"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Context } from "@/util/context"
import { Lock } from "@/util/lock"
import { sha256Content } from "@/util/crypto"
import { Log } from "@/util/log"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { ExperienceEncoder } from "@/library/experience-encoder"
import { ScopeContext } from "@/scope/context"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { lastModel, type InvokeInput } from "./input"
import type { Info } from "./types"
import type { SessionManager } from "./manager"

export namespace SessionInbox {
  const log = Log.create({ service: "session.inbox" })

  // The single scheduling axis for an inbox item (issue #281 §6):
  //   task    — a new task root; starts a loop after the current one ends
  //   steer   — non-root injection that may wake an idle session / promote a call
  //   context — non-root injection that only piggybacks on an already-needed call
  export const ItemMode = z.enum(["task", "steer", "context"])
  export type ItemMode = z.infer<typeof ItemMode>

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
      mode: ItemMode,
      deliveryKey: z.string().optional(),
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
          metadata: z.record(z.string(), z.any()).optional(),
          summary: z
            .object({
              title: z.string().optional(),
              body: z.string().optional(),
            })
            .optional(),
          system: z.string().optional(),
          tools: z.record(z.string(), z.boolean()).optional(),
          variant: z.string().optional(),
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
      deliveryKey: z.string().min(1).optional(),
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
        visible: z.boolean().optional(),
        metadata: z.record(z.string(), z.any()).optional(),
        summary: z
          .object({
            title: z.string().optional(),
            body: z.string().optional(),
          })
          .optional(),
        system: z.string().optional(),
        tools: z.record(z.string(), z.boolean()).optional(),
        variant: z.string().optional(),
      }),
    })
    export const Output = z.object({
      itemID: Identifier.schema("inbox"),
      messageID: Identifier.schema("message"),
      created: z.boolean().optional(),
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
      mode: item.mode,
      deliveryKey: item.deliveryKey,
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

  /** Canonicalize a stored item read from disk: older items may only carry the
   *  retired kind/state/deliveryTarget fields, so derive mode from them once. */
  function normalizeStored(item: StoredItem): StoredItem {
    if (item.mode) return item
    const legacy = item as unknown as { kind?: string; state?: string; deliveryTarget?: string }
    return { ...item, mode: modeFromLegacy(legacy.kind, legacy.state, legacy.deliveryTarget) }
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
    return sortItems(items.filter((item): item is StoredItem => !!item?.id).map(normalizeStored))
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

  /** Compatibility: derive mode from the retired kind/state/deliveryTarget fields. */
  export function modeFromLegacy(kind?: string, state?: string, _deliveryTarget?: string): ItemMode {
    if (kind === "guiding" || state === "guiding") return "steer"
    if (kind === "agent_update") return "steer"
    return "task"
  }

  function mailMode(mail: SessionManager.SessionMail): ItemMode {
    if (mail.type === "assistant") return "context"
    const origin = MessageV2.originFromMetadata(mail.metadata)
    if (mail.noReply === true) return "steer"
    if (origin.type === "cortex" || origin.type === "compaction" || origin.type === "system") return "steer"
    return "task"
  }

  function visibleFor(mode: ItemMode, origin: MessageV2.OriginUser | undefined, explicit?: boolean): boolean {
    if (explicit !== undefined) return explicit
    if (mode === "task") return true
    // User-origin steer items (guide/插话) are always visible;
    // non-user origins need the chip-rendering check (cortex/agenda/…).
    if (origin?.type === "user") return true
    return origin ? MessageV2.originRenders(origin) : false
  }

  async function resolveUserRuntime(
    sessionID: string,
    payload: NonNullable<StoredItem["message"]>,
  ): Promise<{ agent: string; model: { providerID: string; modelID: string } }> {
    const session = await Session.get(sessionID).catch(() => undefined)
    let agentName = payload.agent ?? session?.agentOverride
    if (!agentName) {
      const messages = await Session.messages({ sessionID })
      for (let index = messages.length - 1; index >= 0; index--) {
        const msg = messages[index]
        if (msg.info.role !== "user") continue
        agentName = (msg.info as MessageV2.User).agent
        break
      }
    }

    const agent = await Agent.get(agentName ?? (await Agent.defaultAgent()))
    const inheritedModel = await lastModel(sessionID).catch(() => undefined)
    const model = payload.model ?? session?.modelOverride ?? (await Agent.getAvailableModel(agent)) ?? inheritedModel
    return {
      agent: agent.name,
      model: model ?? { providerID: "system", modelID: "fallback" },
    }
  }

  export async function latestRootID(sessionID: string): Promise<string | undefined> {
    const messages = await Session.messages({ sessionID })
    for (let index = messages.length - 1; index >= 0; index--) {
      const msg = messages[index]
      if (msg.info.role !== "user") continue
      const user = msg.info as MessageV2.User
      if (user.isRoot === true) return user.rootID ?? user.id
    }
  }

  export async function hasRunnableItem(
    sessionID: string,
    options?: { allowSteer?: boolean; excludeIDs?: Set<string> },
  ): Promise<boolean> {
    const items = await peekReady(sessionID, options?.excludeIDs)
    if (items.some((item) => item.mode === "task")) return true
    if (options?.allowSteer === false) return false
    if (!items.some((item) => item.mode === "steer")) return false
    return !!(await latestRootID(sessionID))
  }

  export async function list(sessionID: string): Promise<Item[]> {
    return (await listStored(sessionID)).map(publicItem)
  }

  export async function getStored(sessionID: string, itemID: string): Promise<StoredItem> {
    const session = await readSession(sessionID)
    const scopeID = Identifier.asScopeID((session.scope as Scope).id)
    return normalizeStored(
      await Storage.read<StoredItem>(StoragePath.sessionInboxItem(scopeID, Identifier.asSessionID(sessionID), itemID)),
    )
  }

  function stableDeliveryIDs(sessionID: string, deliveryKey: string): { itemID: string; messageID: string } {
    const hash = sha256Content(`${sessionID}:${deliveryKey}`).slice(0, 26)
    return { itemID: `inb_${hash}`, messageID: `msg_${hash}` }
  }

  function deliveryItem(input: z.infer<typeof Deliver.Input>, ids: { itemID: string; messageID: string }): StoredItem {
    const summarized = summarizeParts(input.message.parts)
    const mode = input.mode
    const origin =
      input.message.role === "user"
        ? (input.message.origin ?? MessageV2.originFromMetadata(input.message.metadata))
        : undefined
    const source: ItemSource = input.message.agent
      ? { type: "agent", label: input.message.agent }
      : origin
        ? { type: origin.type, label: origin.label ?? (origin.type === "user" ? "You" : origin.type) }
        : { type: "agent", label: "Agent" }
    return {
      id: ids.itemID,
      sessionID: input.sessionID,
      deliveryKey: input.deliveryKey,
      mode,
      message: {
        parts: input.message.parts as any,
        role: input.message.role,
        agent: input.message.agent,
        model: input.message.model,
        origin,
        visible: visibleFor(mode, origin, input.message.visible),
        metadata: input.message.metadata,
        summary: input.message.summary,
        system: input.message.system,
        tools: input.message.tools,
        variant: input.message.variant,
      },
      summaryPreview: summarized.preview,
      summary: {
        title: summarized.title,
        preview: summarized.preview,
      },
      detail: summarized.detail,
      source,
      time: { created: Date.now() },
      orderKey: ids.itemID,
      messageID: ids.messageID,
    }
  }

  /**
   * Deliver a new inbox item with the given mode.
   * Pre-allocates messageID for idempotent materialization.
   */
  export const deliver = fn(Deliver.Input, async (input) => {
    const ids = {
      itemID: Identifier.ascending("inbox"),
      messageID: Identifier.ascending("message"),
    }
    const item = deliveryItem(input, ids)
    if (input.message.role === "assistant") {
      await materializeItem(item, await latestRootID(input.sessionID))
      return { ...ids, created: true }
    }

    await writeItem(item)
    return { ...ids, created: true }
  })

  export async function deliverUnique(
    input: z.infer<typeof Deliver.Input> & { deliveryKey: string },
  ): Promise<{ itemID: string; messageID: string; created: boolean }> {
    const ids = stableDeliveryIDs(input.sessionID, input.deliveryKey)
    using _ = await Lock.write(`session-inbox-delivery:${input.sessionID}:${input.deliveryKey}`)

    const existing = await getStored(input.sessionID, ids.itemID).catch(() => undefined)
    if (existing) return { itemID: existing.id, messageID: existing.messageID, created: false }

    const materialized = (await Session.messages({ sessionID: input.sessionID })).some(
      (message) => message.info.id === ids.messageID,
    )
    if (materialized) return { ...ids, created: false }

    const item = deliveryItem(input, ids)
    if (input.message.role === "assistant") {
      await materializeItem(item, await latestRootID(input.sessionID))
    } else {
      await writeItem(item)
    }
    return { ...ids, created: true }
  }

  export async function enqueueUser(input: InvokeInput): Promise<Item> {
    const itemID = Identifier.ascending("inbox")
    const messageID = Identifier.ascending("message")
    const { messageID: _queuedMessageID, ...queuedInput } = input
    const summarized = summarizeParts(input.parts)
    const origin = MessageV2.originFromMetadata(input.metadata)
    const mode: ItemMode = input.noReply === true ? "steer" : "task"
    const item: StoredItem = {
      id: itemID,
      sessionID: input.sessionID,
      mode,
      message: {
        role: "user",
        parts: input.parts as any,
        agent: input.agent,
        model: input.model,
        origin,
        visible: visibleFor(mode, origin),
        metadata: input.metadata,
        summary: input.summary,
        system: input.system,
        tools: input.tools,
        variant: input.variant,
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
    const assistantMail = input.mail as SessionManager.SessionMail.Assistant
    const origin = input.mail.type === "user" ? MessageV2.originFromMetadata(input.mail.metadata) : undefined
    const mode = mailMode(input.mail)
    const item: StoredItem = {
      id: itemID,
      sessionID: input.sessionID,
      mode,
      message: {
        role: input.mail.type === "assistant" ? "assistant" : "user",
        parts: input.mail.parts as any,
        agent: input.mail.type === "assistant" ? assistantMail.agentID : userMail.agent,
        model: input.mail.model,
        origin,
        visible: visibleFor(mode, origin),
        metadata: input.mail.metadata,
        summary: userMail.summary,
        tools: userMail.tools,
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
    if (item.mode === "context") return publicItem(item)
    const updated: StoredItem = {
      ...item,
      mode: item.mode === "task" ? "steer" : "task",
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

  export async function drainReady(sessionID: string): Promise<StoredItem[]> {
    return drainWhere(sessionID, () => true)
  }

  /**
   * Peek ready inbox items without deleting them from storage.
   * Used by the session loop's after-turn boundary so items are only
   * committed after the full reply cycle succeeds.
   */
  export async function peekReady(sessionID: string, excludeIDs?: Set<string>): Promise<StoredItem[]> {
    const items = await listStored(sessionID)
    const ready = items.filter((item) => !excludeIDs || !excludeIDs.has(item.id))
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

  // --- Mode-based drains ---

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

    const role = payload.role
    // Build parts with synthesized IDs
    const parts = payload.parts.map((p: any) => ({
      ...p,
      id: p.id ?? Identifier.ascending("part"),
      messageID,
      sessionID: item.sessionID,
      ...(p.type === "text" && !p.origin ? { origin: p.synthetic ? "system" : "user" } : {}),
    }))

    if (role === "user") {
      if (item.input) {
        const { createUserMessage } = await import("./input")
        return createUserMessage(
          {
            ...item.input,
            sessionID: item.sessionID,
            messageID,
            noReply: item.mode === "task" ? item.input.noReply : true,
          },
          rootID,
        )
      }

      const origin = payload.origin ?? { type: "user" as const }
      const runtime = await resolveUserRuntime(item.sessionID, payload)
      const summary =
        payload.summary?.title || payload.summary?.body
          ? {
              title: payload.summary.title,
              body: payload.summary.body,
              diffs: [],
            }
          : undefined
      // Scheduling & rendering come from mode-derived isRoot/visible/origin;
      // no noReply/guided metadata flags are written.
      const info: MessageV2.User = {
        id: messageID,
        role: "user",
        sessionID: item.sessionID,
        time: { created: Date.now() },
        agent: runtime.agent,
        model: runtime.model,
        isRoot,
        ...(resolvedRootID ? { rootID: resolvedRootID } : {}),
        visible: payload.visible,
        origin,
        ...(payload.metadata ? { metadata: payload.metadata } : {}),
        ...(summary ? { summary } : {}),
        ...(payload.system ? { system: payload.system } : {}),
        ...(payload.tools ? { tools: payload.tools } : {}),
        ...(payload.variant ? { variant: payload.variant } : {}),
      }
      await Session.updateMessage(info)
      for (const part of parts) {
        await Session.updatePart(part)
      }
      return { info, parts }
    }

    // Assistant messages
    const assistantAgent = payload.agent ?? "unknown"
    const assistantModel = payload.model ?? { providerID: "unknown", modelID: "unknown" }
    const info: MessageV2.Assistant = {
      id: messageID,
      role: "assistant",
      sessionID: item.sessionID,
      parentID: rootID ?? messageID,
      rootID: rootID ?? messageID,
      time: { created: Date.now(), completed: Date.now() },
      agent: assistantAgent,
      mode: assistantAgent,
      finish: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
      modelID: assistantModel.modelID,
      providerID: assistantModel.providerID,
      visible: payload.visible,
      ...(payload.metadata ? { metadata: payload.metadata } : {}),
    }
    await Session.updateMessage(info)
    for (const part of parts) {
      await Session.updatePart(part)
    }
    ExperienceEncoder.onComplete(info)
    await Plugin.trigger(
      "session.turn.after",
      {
        sessionID: item.sessionID,
        userMessageID: info.parentID,
        assistantMessageID: info.id,
        assistant: info,
        finish: info.finish,
        error: info.error,
      },
      {},
    )
    return { info, parts }
  }
}
