import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Identifier } from "../id/id"
import { Scope } from "../scope"
import { Storage } from "../storage/storage"
import { StorageIntegrityError } from "../storage/errors"
import { StoragePath } from "../storage/path"
import { Lock } from "../util/lock"
import { sha256Content } from "../util/crypto"
import { Log } from "../util/log"
import { fn } from "../util/fn"
import { RolloutAdmissionError } from "./rollout/error"
import { Agent } from "../agent/agent"
import { SessionPluginHooks as Plugin } from "./plugin-hooks"
import { SessionContextContributions } from "./context-contributions"
import { ScopeContext } from "../scope/context"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { Attachment } from "../attachment"
import { lastModel, type InvokeInput } from "./input"
import type { Info } from "./types"
import type { SessionManager } from "./manager"
import { SessionHistory } from "./history"
import { SessionUserMessageMaterialization } from "./user-message-materialization"
import { SessionRootVariant } from "./root-variant"

export namespace SessionInbox {
  const log = Log.create({ service: "session.inbox" })

  // The single scheduling axis for an inbox item (issue #281 §6):
  //   task    — a new task root; starts a loop after the current one ends
  //   steer   — non-root injection that may wake an idle session / promote a call
  //   context — non-root injection that only piggybacks on an already-needed call
  export const ItemMode = z.enum(["task", "steer", "context"])
  export type ItemMode = z.infer<typeof ItemMode>

  export const FirstTaskLockedError = NamedError.create(
    "SessionInboxFirstTaskLockedError",
    z.object({
      message: z.string(),
      sessionID: Identifier.schema("session"),
      itemID: Identifier.schema("inbox"),
    }),
  )

  export const ItemFailedError = NamedError.create(
    "SessionInboxItemFailedError",
    z.object({
      message: z.string(),
      sessionID: Identifier.schema("session"),
      itemID: Identifier.schema("inbox"),
    }),
  )

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
      // A task whose payload deterministically cannot become a message is
      // parked as failed instead of removed: it stays visible with a reason
      // and can be re-driven (rearm) without wedging the queue behind it.
      status: z.enum(["failed"]).optional(),
      failReason: z.string().optional(),
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
    const message = item.mode === "task" || !item.message ? item.message : { ...item.message, variant: undefined }
    return Item.parse({
      id: item.id,
      sessionID: item.sessionID,
      mode: item.mode,
      status: item.status,
      failReason: item.failReason,
      deliveryKey: item.deliveryKey,
      message,
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

  async function writeItem(item: StoredItem, preserveCreated = false): Promise<StoredItem> {
    return Storage.transaction(async () => {
      {
        if (!preserveCreated) {
          const { SessionManager } = await import("./manager")
          item.time.created = Math.max(
            item.time.created,
            Date.now(),
            SessionManager.fenceQueuedBefore(item.sessionID) ?? 0,
          )
        }
        const session = await readSession(item.sessionID)
        const scopeID = Identifier.asScopeID((session.scope as Scope).id)
        await Storage.write(
          StoragePath.sessionInboxItem(scopeID, Identifier.asSessionID(item.sessionID), item.id),
          item,
        )
      }
      await publish(item.sessionID)
      return item
    })
  }

  async function removeItems(sessionID: string, itemIDs: string[], notify = true): Promise<void> {
    return Storage.transaction(async () => {
      if (itemIDs.length === 0) return
      const session = await readSession(sessionID)
      const scopeID = Identifier.asScopeID((session.scope as Scope).id)
      await Promise.all(
        itemIDs.map((id) =>
          Storage.remove(StoragePath.sessionInboxItem(scopeID, Identifier.asSessionID(sessionID), id)),
        ),
      )
      if (notify) await publish(sessionID)
    })
  }

  async function publish(sessionID: string): Promise<void> {
    const items = await list(sessionID)
    const payload = { sessionID, items }
    const session = await readSession(sessionID)
    const scope = session.scope as Scope
    await ScopeContext.provide({ scope, fn: () => Bus.publish(Event.Updated, payload) })
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
  ): Promise<{ agent: Agent.Info; model: { providerID: string; modelID: string } }> {
    const session = await Session.get(sessionID).catch(() => undefined)
    let agentName = payload.agent ?? session?.agentOverride
    if (!agentName) {
      const messages = await SessionHistory.modelMessages({ sessionID })
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
      agent,
      model: model ?? { providerID: "system", modelID: "fallback" },
    }
  }

  export async function latestRootID(sessionID: string): Promise<string | undefined> {
    const messages = await SessionHistory.modelMessages({ sessionID })
    for (let index = messages.length - 1; index >= 0; index--) {
      const msg = messages[index]
      if (msg.info.role !== "user") continue
      const user = msg.info as MessageV2.User
      if (user.isRoot === true) return user.rootID ?? user.id
    }
  }

  export async function hasRunnableItem(
    sessionID: string,
    options?: { allowSteer?: boolean; excludeIDs?: Set<string>; createdAfter?: number },
  ): Promise<boolean> {
    const stored = await peekReady(sessionID, options?.excludeIDs)
    const items =
      options?.createdAfter === undefined
        ? stored
        : stored.filter((item) => item.time.created >= (options.createdAfter ?? 0))
    if (items.some((item) => item.mode === "task" && item.status !== "failed")) return true
    if (options?.allowSteer === false) return false
    if (!items.some((item) => item.mode === "steer" && item.status !== "failed")) return false
    return !!(await latestRootID(sessionID))
  }

  /**
   * Discover task-mode inbox records first, then exclude missing or archived
   * owners without traversing empty historical inboxes.
   */
  export async function listRunnableSessions(scopeID?: string): Promise<string[]> {
    const candidates = new Map<string, string>()
    let after: string[] | undefined
    for (;;) {
      const keys = await Storage.queryKeys({ kind: "inbox", scopeID, after, limit: 256 })
      const items = await readRecoveryBatch<StoredItem>(keys)
      for (let i = 0; i < keys.length; i++) {
        const item = items[i]
        if (!item?.id) continue
        const normalized = normalizeStored(item)
        if (normalized.mode === "task" && normalized.status !== "failed") candidates.set(keys[i][2], keys[i][1])
      }
      if (keys.length < 256) break
      after = keys.at(-1)
    }
    const result: string[] = []
    const entries = [...candidates]
    for (let offset = 0; offset < entries.length; offset += 256) {
      const batch = entries.slice(offset, offset + 256)
      const infos = await readRecoveryBatch<Info>(
        batch.map(([sessionID, scope]) =>
          StoragePath.sessionInfo(Identifier.asScopeID(scope), Identifier.asSessionID(sessionID)),
        ),
      )
      for (const info of infos) if (info?.time && !info.time.archived) result.push(info.id)
    }
    return result.sort()
  }

  async function readRecoveryBatch<T>(keys: string[][]): Promise<(T | undefined)[]> {
    try {
      return await Storage.readMany<T>(keys)
    } catch (error) {
      if (!(error instanceof StorageIntegrityError)) throw error
    }
    return Promise.all(
      keys.map(async (key) => {
        try {
          return await Storage.read<T>(key, { silentNotFound: true })
        } catch (error) {
          if (error instanceof Storage.NotFoundError) return undefined
          if (!(error instanceof StorageIntegrityError)) throw error
          log.warn("startup inbox discovery skipped an unreadable record", {
            scopeID: key[1],
            sessionID: key[2],
            error,
          })
          return undefined
        }
      }),
    )
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

  export async function get(sessionID: string, itemID: string): Promise<Item> {
    return publicItem(await getStored(sessionID, itemID))
  }

  export function stableDeliveryItemID(sessionID: string, deliveryKey: string): string {
    const hash = sha256Content(`${sessionID}:${deliveryKey}`).slice(0, 26)
    return `inb_${hash}`
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
      orderKey: ids.messageID,
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

  async function findExistingDelivery(sessionID: string, deliveryKey: string) {
    const itemID = stableDeliveryItemID(sessionID, deliveryKey)
    const existing = await getStored(sessionID, itemID).catch((error) => {
      if (error instanceof Storage.NotFoundError) return
      throw error
    })
    if (existing) return { itemID: existing.id, messageID: existing.messageID }

    const session = await readSession(sessionID)
    const [receipt] = await Storage.readMany<{ itemID: string; messageID: string }>([
      [
        ...StoragePath.sessionRoot(Identifier.asScopeID(session.scope.id), Identifier.asSessionID(sessionID)),
        "inbox-materialized",
        itemID,
      ],
    ])
    if (receipt) return { itemID: receipt.itemID, messageID: receipt.messageID }
    return undefined
  }

  async function deliverUniqueWithPreparedMessage(
    input: {
      sessionID: string
      deliveryKey: string
      mode: z.infer<typeof Deliver.Input>["mode"]
      prepareMessage: (messageID: string) => Promise<z.infer<typeof Deliver.Input>["message"]>
    },
    persistItem: (item: StoredItem) => Promise<unknown>,
  ): Promise<{ itemID: string; messageID: string; created: boolean }> {
    const itemID = stableDeliveryItemID(input.sessionID, input.deliveryKey)
    using _ = await Lock.write(`session-inbox-delivery:${input.sessionID}:${input.deliveryKey}`)

    const existing = await findExistingDelivery(input.sessionID, input.deliveryKey)
    if (existing) return { ...existing, created: false }

    const ids = { itemID, messageID: Identifier.ascending("message") }
    const message = await input.prepareMessage(ids.messageID)
    await persistItem(
      deliveryItem(
        {
          sessionID: input.sessionID,
          deliveryKey: input.deliveryKey,
          mode: input.mode,
          message,
        },
        ids,
      ),
    )
    return { ...ids, created: true }
  }

  export async function deliverUnique(
    input: z.infer<typeof Deliver.Input> & { deliveryKey: string },
  ): Promise<{ itemID: string; messageID: string; created: boolean }> {
    return deliverUniqueWithPreparedMessage(
      {
        sessionID: input.sessionID,
        deliveryKey: input.deliveryKey,
        mode: input.mode,
        prepareMessage: async () => input.message,
      },
      async (item) => {
        if (input.message.role === "assistant") {
          await materializeItem(item, await latestRootID(input.sessionID))
          return
        }
        await writeItem(item)
      },
    )
  }

  export async function deliverUniquePrepared(input: {
    sessionID: string
    deliveryKey: string
    mode: z.infer<typeof Deliver.Input>["mode"]
    prepareMessage: (messageID: string) => Promise<z.infer<typeof Deliver.Input>["message"]>
  }): Promise<{ itemID: string; messageID: string; created: boolean }> {
    return deliverUniqueWithPreparedMessage(input, writeItem)
  }

  export async function enqueueUser(input: InvokeInput): Promise<Item> {
    await Session.assertWorkspaceAvailable(input.sessionID)
    const itemID = Identifier.ascending("inbox")
    const messageID = Identifier.ascending("message")
    const { messageID: _queuedMessageID, ...queuedInput } = input
    const summarized = summarizeParts(input.parts)
    const origin = MessageV2.originFromMetadata(input.metadata)
    const mode: ItemMode = input.noReply === true ? "steer" : "task"
    let taskSession: Info | undefined
    if (mode === "task") {
      taskSession = await readSession(input.sessionID)
      if (input.experiment) {
        // Admission stays fail-fast before the item is stored; configuration
        // resolution itself happens at materialization, off the request path.
        const { RolloutLifecycle } = await import("./rollout/lifecycle")
        await RolloutLifecycle.assertQueuedExperiment(taskSession, input.experiment)
      }
    } else if (input.experiment) throw new Error("Experiment configuration requires a root task")
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
    const stored = await writeItem(item)
    if (taskSession) {
      // Open a lightweight run shell (no configuration or provenance) so
      // status polls and cancellation observe a durable record immediately;
      // heavy admission work attaches at materialization, off this path. The
      // shell is best-effort — materialization opens the run lazily when the
      // shell write failed.
      const { RolloutLifecycle } = await import("./rollout/lifecycle")
      const { RolloutLedger } = await import("./rollout/ledger")
      await RolloutLedger.beginRun(RolloutLifecycle.owner(taskSession), messageID).catch((error) => {
        log.warn("failed to open queued task run shell", { sessionID: input.sessionID, messageID, error })
      })
    }
    // The inbox is durable first; return only after navigation observes the accepted input.
    await Session.recordActivity(input.sessionID).catch((error) => {
      log.warn("failed to record session activity after user inbox enqueue", { sessionID: input.sessionID, error })
    })
    return publicItem(stored)
  }

  function mailItem(
    input: { sessionID: string; mail: SessionManager.SessionMail },
    ids: { itemID: string; messageID: string; orderKey: string },
    deliveryKey?: string,
  ): StoredItem {
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
    return {
      id: ids.itemID,
      sessionID: input.sessionID,
      deliveryKey,
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
      orderKey: ids.orderKey,
      messageID: ids.messageID,
    }
  }

  export async function enqueueMail(input: { sessionID: string; mail: SessionManager.SessionMail }): Promise<Item> {
    const itemID = Identifier.ascending("inbox")
    const ids = { itemID, messageID: Identifier.ascending("message"), orderKey: itemID }
    return publicItem(await writeItem(mailItem(input, ids)))
  }

  export async function enqueueMailUnique(input: {
    sessionID: string
    deliveryKey: string
    mail: SessionManager.SessionMail
  }): Promise<{ itemID: string; messageID: string; created: boolean }> {
    const itemID = stableDeliveryItemID(input.sessionID, input.deliveryKey)
    using _ = await Lock.write(`session-inbox-delivery:${input.sessionID}:${input.deliveryKey}`)

    const existing = await findExistingDelivery(input.sessionID, input.deliveryKey)
    if (existing) return { ...existing, created: false }

    const orderKey = Identifier.ascending("inbox")
    const messageID = Identifier.ascending("message")
    const ids = { itemID, messageID, orderKey }
    await writeItem(mailItem(input, ids, input.deliveryKey))
    return { itemID, messageID, created: true }
  }

  export async function assertMutable(input: { sessionID: string; itemID: string }): Promise<StoredItem> {
    const item = await getStored(input.sessionID, input.itemID)
    // A parked failure stays mutable (rearm, remove) even as the first task
    // of a session whose canonical root never materialized.
    if (item.mode === "task" && item.status !== "failed" && !(await latestRootID(input.sessionID))) {
      throw new FirstTaskLockedError({
        message: "The first queued task cannot be changed until its conversation root is ready.",
        sessionID: input.sessionID,
        itemID: input.itemID,
      })
    }
    return item
  }

  /**
   * Guide: flip mode task↔steer.
   * A task item becomes steer (joins next model call).
   * A steer item becomes task (queues for after-turn).
   */
  export async function guide(input: { sessionID: string; itemID: string }): Promise<Item> {
    return Storage.transaction(async () => {
      const item = await assertMutable(input)
      if (item.mode === "context") return publicItem(item)
      if (item.status === "failed") {
        // Retry must reopen the failed rollout before its payload becomes runnable.
        throw new ItemFailedError({
          message: "A failed item cannot be guided; retry delivery or delete it instead.",
          sessionID: input.sessionID,
          itemID: input.itemID,
        })
      }
      const updated: StoredItem = {
        ...item,
        mode: item.mode === "task" ? "steer" : "task",
        time: {
          ...item.time,
          updated: Date.now(),
        },
      }
      return publicItem(await writeItem(updated, true))
    })
  }

  /**
   * Remove any inbox item (not just queued_user).
   */
  export async function remove(input: { sessionID: string; itemID: string }): Promise<void> {
    await removeItems(input.sessionID, [input.itemID])
  }

  async function drainWhere(sessionID: string, predicate: (item: StoredItem) => boolean): Promise<StoredItem[]> {
    return Storage.transaction(async () => {
      const items = await listStored(sessionID)
      const drained = items.filter(predicate)
      if (drained.length === 0) return []
      await removeItems(
        sessionID,
        drained.map((item) => item.id),
      )
      log.info("drained inbox items", { sessionID, count: drained.length })
      return drained
    })
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

  export async function peekSteer(sessionID: string): Promise<StoredItem[]> {
    return (await listStored(sessionID)).filter((item) => item.mode === "steer" && item.status !== "failed")
  }

  export async function peekContext(sessionID: string): Promise<StoredItem[]> {
    return (await listStored(sessionID)).filter(
      (item) => item.mode === "context" && item.message?.role === "user" && item.status !== "failed",
    )
  }

  export async function peekTask(sessionID: string): Promise<StoredItem | undefined> {
    const items = await listStored(sessionID)
    return items.find((item) => item.mode === "task" && item.status !== "failed")
  }

  export async function fenceQueuedWork(sessionID: string, onFence: (createdBefore: number) => void): Promise<number> {
    return Storage.transaction(async () => {
      let removed: number
      {
        const { SessionManager } = await import("./manager")
        const items = await listStored(sessionID)
        const createdBefore =
          SessionManager.fenceQueuedBefore(sessionID) ??
          Math.max(Date.now(), ...items.map((item) => item.time.created)) + 1
        Storage.afterCommit(() => onFence(createdBefore))
        removed = await removeByModesUnlocked(sessionID, ["task", "steer", "context"], createdBefore)
      }
      if (removed > 0) await publish(sessionID)
      return removed
    })
  }

  export async function removeByModes(sessionID: string, modes: ItemMode[], createdBefore?: number): Promise<number> {
    return Storage.transaction(async () => {
      let removed: number
      {
        removed = await removeByModesUnlocked(sessionID, modes, createdBefore)
      }
      if (removed > 0) await publish(sessionID)
      return removed
    })
  }

  async function removeByModesUnlocked(sessionID: string, modes: ItemMode[], createdBefore?: number): Promise<number> {
    const items = await listStored(sessionID)
    const ids = items
      .filter((item) => modes.includes(item.mode))
      .filter((item) => createdBefore === undefined || item.time.created < createdBefore)
      .map((item) => item.id)
    if (ids.length === 0) return 0
    await removeItems(sessionID, ids, false)
    return ids.length
  }

  // --- Idempotent materialization (Commit 2) ---

  export async function materializeItem(
    item: StoredItem,
    rootID?: string,
    options?: { guiding?: boolean },
  ): Promise<MessageV2.WithParts | undefined> {
    try {
      return await materializeStoredItem(item, rootID, options)
    } catch (error) {
      if (item.mode !== "task" && error instanceof Attachment.InvalidUrlError)
        await parkTaskFailure(item.sessionID, item, error.message)
      throw error
    }
  }

  async function materializeStoredItem(
    item: StoredItem,
    rootID?: string,
    options?: { guiding?: boolean },
  ): Promise<MessageV2.WithParts | undefined> {
    const commitOptions: SessionUserMessageMaterialization.CommitOptions = {
      commit: async () => {
        const session = await readSession(item.sessionID)
        const scopeID = Identifier.asScopeID(session.scope.id)
        const sid = Identifier.asSessionID(item.sessionID)
        await Storage.write([...StoragePath.sessionRoot(scopeID, sid), "inbox-materialized", item.id], {
          itemID: item.id,
          messageID: item.messageID,
          deliveryKey: item.deliveryKey,
          completedAt: Date.now(),
        })
        await removeItems(item.sessionID, [item.id])
      },
    }
    const existing = await MessageV2.get({ sessionID: item.sessionID, messageID: item.messageID }).catch((error) => {
      if (error instanceof Storage.NotFoundError) return
      throw error
    })
    if (existing) {
      await Storage.transaction(() => commitOptions.commit!(existing))
      return existing
    }

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
          commitOptions,
        )
      }

      const origin = payload.origin ?? { type: "user" as const }
      const runtime = await resolveUserRuntime(item.sessionID, payload)
      const variant = isRoot
        ? await SessionRootVariant.resolveForRoot({ explicit: payload.variant, ...runtime })
        : undefined
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
        agent: runtime.agent.name,
        model: runtime.model,
        isRoot,
        ...(resolvedRootID ? { rootID: resolvedRootID } : {}),
        visible: payload.visible,
        origin,
        ...(payload.metadata || item.deliveryKey
          ? {
              metadata: {
                ...payload.metadata,
                ...(item.deliveryKey ? { inboxDeliveryKey: item.deliveryKey } : {}),
              },
            }
          : {}),
        ...(summary ? { summary } : {}),
        ...(payload.system ? { system: payload.system } : {}),
        ...(payload.tools ? { tools: payload.tools } : {}),
        ...(variant ? { variant } : {}),
      }
      return SessionUserMessageMaterialization.write({ info, parts }, commitOptions)
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
      path: { cwd: ScopeContext.current.workspace?.path ?? null, root: ScopeContext.current.workspace?.path ?? null },
      modelID: assistantModel.modelID,
      providerID: assistantModel.providerID,
      visible: payload.visible,
      ...(payload.metadata || item.deliveryKey
        ? {
            metadata: {
              ...payload.metadata,
              ...(item.deliveryKey ? { inboxDeliveryKey: item.deliveryKey } : {}),
            },
          }
        : {}),
    }
    const result = await SessionUserMessageMaterialization.write({ info, parts }, commitOptions)
    await SessionContextContributions.onAssistantComplete(info)
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

  export type TaskMaterializationResult =
    | { status: "materialized"; itemID: string; messageID: string }
    | { status: "failed"; itemID: string; reason: string }
    | { status: "empty" }

  /**
   * Materialize the next runnable task. Inputs that deterministically cannot
   * become a runnable root (attachment capture failures and similar
   * InvalidUrlError-class payload errors, plus RolloutAdmissionError-class
   * configuration failures) are parked as failed instead of throwing: the
   * item stays visible with a reason, the queue behind it proceeds, and
   * retry can re-drive it after the underlying input is repaired.
   */
  export async function materializeNextTask(sessionID: string): Promise<TaskMaterializationResult> {
    const task = await peekTask(sessionID)
    if (!task) return { status: "empty" }
    try {
      const materialized = await materializeItem(task)
      if (!materialized) {
        if (!(await parkTaskFailure(sessionID, task, "Inbox task payload could not be materialized")))
          return { status: "empty" }
        return { status: "failed", itemID: task.id, reason: "Inbox task payload could not be materialized" }
      }
    } catch (error) {
      // A cancellation racing materialization removed the queued item and
      // terminalized its run; report no runnable work instead of parking
      // (parking would resurrect the cancelled item) or surfacing an error.
      if (error instanceof DOMException && error.name === "AbortError") return { status: "empty" }
      if (!(error instanceof Attachment.InvalidUrlError) && !RolloutAdmissionError.isInstance(error)) throw error
      const reason = RolloutAdmissionError.isInstance(error)
        ? error.data.message
        : (error as Attachment.InvalidUrlError).message
      if (!(await parkTaskFailure(sessionID, task, reason))) return { status: "empty" }
      return { status: "failed", itemID: task.id, reason }
    }
    return { status: "materialized", itemID: task.id, messageID: task.messageID }
  }

  async function parkTaskFailure(sessionID: string, task: StoredItem, reason: string): Promise<boolean> {
    const parked = await Storage.transaction(async () => {
      const current = await getStored(sessionID, task.id).catch((error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      })
      if (!current) return false
      await writeItem(
        {
          ...current,
          status: "failed",
          failReason: reason,
          time: { ...current.time, updated: Date.now() },
        },
        true,
      )
      return true
    })
    if (!parked) return false
    log.warn("parked inbox task that cannot materialize", {
      sessionID,
      itemID: task.id,
      messageID: task.messageID,
      reason,
    })
    return true
  }

  /** Clear a parked failure so the item becomes runnable again. */
  export async function rearm(input: { sessionID: string; itemID: string }): Promise<Item> {
    const item = await getStored(input.sessionID, input.itemID)
    if (item.status !== "failed") return publicItem(item)
    // The failed materialization terminalized this task's rollout before the
    // payload error surfaced; reopen it so the retry can open a segment
    // instead of hitting the terminal-rollout guard with no item left.
    if (item.mode === "task") {
      const { RolloutLifecycle } = await import("./rollout/lifecycle")
      const { RolloutLedger } = await import("./rollout/ledger")
      const session = await Session.get(input.sessionID)
      await RolloutLedger.reopenRun(RolloutLifecycle.owner(session), item.messageID)
    }
    const cleared: StoredItem = {
      ...item,
      status: undefined,
      failReason: undefined,
      time: { ...item.time, updated: Date.now() },
    }
    return publicItem(await writeItem(cleared, true))
  }
}
