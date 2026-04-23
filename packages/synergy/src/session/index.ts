import { Decimal } from "decimal.js"
import z from "zod"
import { type LanguageModelUsage, type ProviderMetadata } from "ai"
import { Identifier } from "../id/id"
import { Installation } from "../global/installation"
import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"

import { Bus } from "../bus"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"
import { Instance } from "../scope/instance"
import { Scope } from "@/scope"
import { fn } from "@/util/fn"
import { Snapshot } from "@/session/snapshot"

import type { Provider } from "@/provider/provider"
import { PermissionNext } from "@/permission/next"
import { SessionInteraction } from "./interaction"
import { SessionManager } from "./manager"
import { SessionEvent } from "./event"
import { Info as InfoSchema, StatusInfo as StatusInfoSchema } from "./types"
import type { Info as InfoType, StatusInfo as StatusInfoType } from "./types"
import { SessionEndpoint } from "./endpoint"
import { createDefaultTitle } from "./title"

export namespace Session {
  export const Info = InfoSchema
  export const StatusInfo = StatusInfoSchema
  export type Info = InfoType
  export type StatusInfo = StatusInfoType

  const log = Log.create({ service: "session" })
  const { asScopeID, asSessionID, asMessageID, asPartID } = Identifier

  export function toIndex(session: Info) {
    const scope = session.scope as Scope
    return {
      sessionID: session.id,
      scopeID: scope.id,
      directory: scope.directory,
      parentID: session.parentID,
      endpoint: session.endpoint,
      endpointKey: session.endpoint ? SessionEndpoint.toKey(session.endpoint) : undefined,
    }
  }

  export function withoutRuntimeInfo(session: Info): Info {
    const result = { ...session }
    delete result.allowAll
    return result
  }

  export type PageIndex = {
    entries: Array<{
      id: string
      updated: number
      created: number
      pinned: number
      archived: boolean
      parentID?: string
    }>
  }

  export async function readPageIndex(scopeID: string): Promise<PageIndex> {
    return Storage.read<PageIndex>(StoragePath.sessionsPageIndex(asScopeID(scopeID))).catch(() => ({ entries: [] }))
  }

  export async function writePageIndex(scopeID: string, index: PageIndex) {
    await Storage.write(StoragePath.sessionsPageIndex(asScopeID(scopeID)), index)
  }

  export async function upsertPageIndexEntry(scopeID: string, entry: PageIndex["entries"][number]) {
    const index = await readPageIndex(scopeID)
    const existing = index.entries.findIndex((e) => e.id === entry.id)
    if (existing >= 0) index.entries.splice(existing, 1)
    const insertAt = index.entries.findIndex((e) => e.updated <= entry.updated)
    if (insertAt === -1) index.entries.push(entry)
    else index.entries.splice(insertAt, 0, entry)
    await writePageIndex(scopeID, index)
  }

  export async function removePageIndexEntry(scopeID: string, sessionID: string) {
    const index = await readPageIndex(scopeID)
    index.entries = index.entries.filter((e) => e.id !== sessionID)
    await writePageIndex(scopeID, index)
  }

  function toPageIndexEntry(session: Info): PageIndex["entries"][number] {
    return {
      id: session.id,
      updated: session.time.updated,
      created: session.time.created,
      pinned: session.pinned ?? 0,
      archived: !!session.time.archived,
      parentID: session.parentID,
    }
  }

  async function writeEndpointIndex(session: Info) {
    if (!session.endpoint) return

    const endpointKey = SessionEndpoint.toKey(session.endpoint)
    await Storage.write(StoragePath.endpointSession(endpointKey, asSessionID(session.id)), {
      sessionID: session.id,
      scopeID: (session.scope as Scope).id,
    })
  }

  async function removeEndpointIndex(session: Info) {
    if (!session.endpoint) return

    const endpointKey = SessionEndpoint.toKey(session.endpoint)
    await Storage.remove(StoragePath.endpointSession(endpointKey, asSessionID(session.id))).catch(() => undefined)
  }

  export async function withRuntimeInfo(session: Info): Promise<Info> {
    return {
      ...withoutRuntimeInfo(session),
      allowAll: await PermissionNext.isAllowingAll(session.id),
    }
  }

  async function publishInfo(event: typeof SessionEvent.Created | typeof SessionEvent.Updated, session: Info) {
    Bus.publish(event, {
      info: await withRuntimeInfo(session),
    })
  }

  export async function create(input?: {
    scope?: Scope
    parentID?: string
    title?: string
    permission?: PermissionNext.Ruleset
    endpoint?: SessionEndpoint.Info
    id?: string
    agenda?: { itemID: string }
    interaction?: SessionInteraction.Info
  }) {
    const scope = input?.scope ?? Instance.scope
    const inheritedInteraction =
      input?.interaction ??
      (input?.parentID ? (await SessionManager.getSession(input.parentID))?.interaction : undefined)

    const endpoint = input?.endpoint

    const result: Info = {
      id: Identifier.descending("session", input?.id),
      version: Installation.VERSION,
      scope,
      parentID: input?.parentID,
      title: input?.title ?? createDefaultTitle(!!input?.parentID),
      permission: input?.permission,
      endpoint,
      interaction: inheritedInteraction,
      agenda: input?.agenda,
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    }
    log.info("created", result)

    await Storage.write(
      StoragePath.sessionInfo(asScopeID(scope.id), asSessionID(result.id)),
      withoutRuntimeInfo(result),
    )
    await Storage.write(StoragePath.sessionIndex(asSessionID(result.id)), toIndex(result))
    await writeEndpointIndex(result)
    await upsertPageIndexEntry(scope.id, toPageIndexEntry(result))

    if (result.agenda) {
      await Storage.write(StoragePath.agendaSession(result.agenda.itemID, result.id), {
        sessionID: result.id,
        scopeID: scope.id,
      })
    }

    if (input?.parentID) PermissionNext.registerParent(result.id, input.parentID)

    SessionManager.registerRuntime(result.id)
    Scope.touch(scope.id)

    await publishInfo(SessionEvent.Created, result)
    await publishInfo(SessionEvent.Updated, result)
    return withRuntimeInfo(result)
  }

  export const fork = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message").optional(),
    }),
    async (input) => {
      const session = await create()
      const msgs = await messages({ sessionID: input.sessionID })
      for (const msg of msgs) {
        if (input.messageID && msg.info.id >= input.messageID) break
        const cloned = await updateMessage({
          ...msg.info,
          sessionID: session.id,
          id: Identifier.ascending("message"),
        })

        for (const part of msg.parts) {
          await updatePart({
            ...part,
            id: Identifier.ascending("part"),
            messageID: cloned.id,
            sessionID: session.id,
          })
        }
      }
      return session
    },
  )

  export const touch = fn(Identifier.schema("session"), async (sessionID) => {
    await update(sessionID, (draft) => {
      draft.time.updated = Date.now()
    })
  })

  export const get = fn(Identifier.schema("session"), async (id) => {
    const session = await SessionManager.requireSession(id)
    const scope = session.scope as Scope
    const read = await Storage.read<Info>(StoragePath.sessionInfo(asScopeID(scope.id), asSessionID(id)))
    return withRuntimeInfo(read as Info)
  })

  export async function update(id: string, editor: (session: Info) => void) {
    const session = await SessionManager.requireSession(id)
    const scope = session.scope as Scope
    const before = await Storage.read<Info>(StoragePath.sessionInfo(asScopeID(scope.id), asSessionID(id)))
    const result = await Storage.update<Info>(
      StoragePath.sessionInfo(asScopeID(scope.id), asSessionID(id)),
      (draft) => {
        editor(draft)
        draft.time.updated = Date.now()
      },
    )

    await Storage.write(StoragePath.sessionInfo(asScopeID(scope.id), asSessionID(id)), withoutRuntimeInfo(result))
    await Storage.write(StoragePath.sessionIndex(asSessionID(result.id)), toIndex(result))
    await upsertPageIndexEntry(scope.id, toPageIndexEntry(result))

    const beforeKey = before.endpoint ? SessionEndpoint.toKey(before.endpoint) : undefined
    const afterKey = result.endpoint ? SessionEndpoint.toKey(result.endpoint) : undefined
    if (beforeKey && beforeKey !== afterKey) {
      await removeEndpointIndex(before)
    }
    if (result.endpoint) {
      await writeEndpointIndex(result)
    }

    await publishInfo(SessionEvent.Updated, result)
    return withRuntimeInfo(result)
  }

  export const diff = fn(Identifier.schema("session"), async (sessionID) => {
    const session = await SessionManager.requireSession(sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    const diffs = await Storage.read<Snapshot.FileDiff[]>(StoragePath.sessionSummary(scopeID, asSessionID(sessionID)))
    return diffs ?? []
  })

  export const messages = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      limit: z.number().optional(),
    }),
    async (input) => {
      const result = [] as MessageV2.WithParts[]
      for await (const msg of MessageV2.stream({ sessionID: input.sessionID })) {
        if (input.limit && result.length >= input.limit) break
        result.push(msg)
      }
      result.reverse()
      return result
    },
  )

  export type ListResult = {
    data: Info[]
    total: number
  }

  export async function list(options?: {
    offset?: number
    limit?: number
    search?: string
    since?: number
    before?: number
    pinned?: boolean
    parentOnly?: boolean
  }): Promise<ListResult> {
    const scopeID = asScopeID(Instance.scope.id)
    const index = await readPageIndex(scopeID)
    let entries = index.entries.filter((e) => !e.archived)

    if (options?.parentOnly !== false) entries = entries.filter((e) => !e.parentID)
    if (options?.pinned) entries = entries.filter((e) => e.pinned > 0)
    if (options?.since) entries = entries.filter((e) => e.updated >= options.since!)
    if (options?.before) entries = entries.filter((e) => e.updated < options.before!)

    // When searching, we must read all matching session infos first because
    // title-based search cannot be applied on the page index alone.
    if (options?.search) {
      const keys = entries.map((e) => StoragePath.sessionInfo(scopeID, asSessionID(e.id)))
      const sessions = await Storage.readMany<Info>(keys)
      const term = options.search.toLowerCase()
      const matched = sessions.filter((s): s is Info => s != null && !!s.scope && s.title.toLowerCase().includes(term))
      const total = matched.length
      const offset = options?.offset ?? 0
      const limit = options?.limit ?? total
      const data = matched.slice(offset, offset + limit)
      return { data, total }
    }

    const total = entries.length
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? total
    const slice = entries.slice(offset, offset + limit)

    if (slice.length === 0) return { data: [], total }

    const keys = slice.map((e) => StoragePath.sessionInfo(scopeID, asSessionID(e.id)))
    const sessions = await Storage.readMany<Info>(keys)
    const data = sessions.filter((s): s is Info => s != null && !!s.scope)

    return { data, total }
  }

  export async function* listAll() {
    const scopeID = asScopeID(Instance.scope.id)
    const ids = await Storage.scan(StoragePath.sessionsRoot(scopeID))
    const keys = ids.map((id) => StoragePath.sessionInfo(scopeID, asSessionID(id)))
    const sessions = await Storage.readMany<Info>(keys)
    for (const session of sessions) {
      if (session && session.scope) yield session as Info
    }
  }

  export const children = fn(Identifier.schema("session"), async (parentID) => {
    const sessions: Info[] = []
    for await (const session of listAll()) {
      if (session.parentID === parentID) sessions.push(session)
    }
    return sessions
  })

  export const remove = fn(Identifier.schema("session"), async (sessionID) => {
    try {
      const session = await get(sessionID)
      const scope = session.scope as Scope
      const scopeID = asScopeID(scope.id)
      for (const child of await children(sessionID)) {
        await remove(child.id)
      }
      SessionManager.unregisterRuntime(sessionID)
      await removeEndpointIndex(session)
      await Storage.removeTree(StoragePath.sessionRoot(scopeID, asSessionID(sessionID)))
      await Storage.remove(StoragePath.sessionIndex(asSessionID(sessionID)))
      await removePageIndexEntry(scope.id, sessionID)
      Bus.publish(SessionEvent.Deleted, {
        info: session,
      })
    } catch (e) {
      log.error(e)
    }
  })

  export async function updateLastExchange(sessionID: string) {
    const session = await SessionManager.requireSession(sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    const lastExchange: NonNullable<Info["lastExchange"]> = {}
    for await (const msg of MessageV2.stream({ sessionID })) {
      if (!lastExchange.assistant && msg.info.role === "assistant") {
        const text = MessageV2.extractText(msg.parts, { maxLength: 200 })
        if (text) lastExchange.assistant = text
      }
      if (!lastExchange.user && msg.info.role === "user") {
        const text = MessageV2.extractText(msg.parts, { maxLength: 200 })
        if (text) lastExchange.user = text
      }
      if (lastExchange.user && lastExchange.assistant) break
    }
    // Write lastExchange directly without bumping time.updated or republishing,
    // since the caller (processor) already performs a proper Session.update().
    const infoPath = StoragePath.sessionInfo(scopeID, asSessionID(sessionID))
    await Storage.update<Info>(infoPath, (draft) => {
      draft.lastExchange = lastExchange
    })
  }

  export const updateMessage = fn(MessageV2.Info, async (msg) => {
    const session = await SessionManager.requireSession(msg.sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    await Storage.write(StoragePath.messageInfo(scopeID, asSessionID(msg.sessionID), asMessageID(msg.id)), msg)
    Bus.publish(MessageV2.Event.Updated, {
      info: msg,
    })
    return msg
  })

  export const removeMessage = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      const session = await SessionManager.requireSession(input.sessionID)
      const scopeID = asScopeID((session.scope as Scope).id)
      await Storage.remove(StoragePath.messageInfo(scopeID, asSessionID(input.sessionID), asMessageID(input.messageID)))
      Bus.publish(MessageV2.Event.Removed, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    },
  )

  export const removePart = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
      partID: Identifier.schema("part"),
    }),
    async (input) => {
      const session = await SessionManager.requireSession(input.sessionID)
      const scopeID = asScopeID((session.scope as Scope).id)
      await Storage.remove(
        StoragePath.messagePart(
          scopeID,
          asSessionID(input.sessionID),
          asMessageID(input.messageID),
          asPartID(input.partID),
        ),
      )
      Bus.publish(MessageV2.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      return input.partID
    },
  )

  const UpdatePartInput = z.union([
    MessageV2.Part,
    z.object({
      part: MessageV2.TextPart,
      delta: z.string(),
    }),
    z.object({
      part: MessageV2.ReasoningPart,
      delta: z.string(),
    }),
  ])

  export const updatePart = fn(UpdatePartInput, async (input) => {
    const part = "delta" in input ? input.part : input
    const delta = "delta" in input ? input.delta : undefined
    const session = await SessionManager.requireSession(part.sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    await Storage.write(
      StoragePath.messagePart(scopeID, asSessionID(part.sessionID), asMessageID(part.messageID), asPartID(part.id)),
      part,
    )
    Bus.publish(MessageV2.Event.PartUpdated, {
      part,
      delta,
    })
    return part
  })

  export const getUsage = fn(
    z.object({
      model: z.custom<Provider.Model>(),
      usage: z.custom<LanguageModelUsage>(),
      metadata: z.custom<ProviderMetadata>().optional(),
    }),
    (input) => {
      const cachedInputTokens = input.usage.cachedInputTokens ?? 0
      const excludesCachedTokens = !!(input.metadata?.["anthropic"] || input.metadata?.["bedrock"])
      const adjustedInputTokens = excludesCachedTokens
        ? (input.usage.inputTokens ?? 0)
        : (input.usage.inputTokens ?? 0) - cachedInputTokens
      const safe = (value: number) => {
        if (!Number.isFinite(value)) return 0
        return value
      }

      const tokens = {
        input: safe(adjustedInputTokens),
        output: safe(input.usage.outputTokens ?? 0),
        reasoning: safe(input.usage?.reasoningTokens ?? 0),
        cache: {
          write: safe(
            (input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
              // @ts-expect-error
              input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
              0) as number,
          ),
          read: safe(cachedInputTokens),
        },
      }

      const costInfo =
        input.model.cost?.experimentalOver200K && ModelLimit.actualInput(tokens) > 200_000
          ? input.model.cost.experimentalOver200K
          : input.model.cost
      return {
        cost: safe(
          new Decimal(0)
            .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
            .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
            .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
            .toNumber(),
        ),
        tokens,
      }
    },
  )

  export async function findForEndpoint(endpoint: SessionEndpoint.Info) {
    return SessionManager.getSession(endpoint)
  }

  export async function getOrCreateForEndpoint(
    endpoint: SessionEndpoint.Info,
    scope?: Scope,
    interaction?: SessionInteraction.Info,
  ) {
    const existing = await SessionManager.getSession(endpoint)
    if (existing) {
      if (interaction && existing.interaction?.mode !== interaction.mode) {
        return update(existing.id, (draft) => {
          draft.interaction = interaction
        })
      }
      return existing
    }
    return create({ scope, endpoint, interaction })
  }

  export async function archiveEndpointSession(endpoint: SessionEndpoint.Info) {
    const session = await SessionManager.getSession(endpoint)
    if (!session) return
    await update(session.id, (draft) => {
      draft.time.archived = Date.now()
    })
    SessionManager.unregisterRuntime(session.id)
  }

  export function isRunning(sessionID: string) {
    return SessionManager.isRunning(sessionID)
  }

  export async function deliver(input: { target: string | SessionEndpoint.Info; mail: SessionManager.SessionMail }) {
    await SessionManager.deliver(input)
  }
}
