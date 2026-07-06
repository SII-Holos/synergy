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
import { ScopeContext } from "../scope/context"
import { Scope } from "@/scope"
import { fn } from "@/util/fn"
import { Snapshot } from "@/session/snapshot"
import { SnapshotSchema } from "@/session/snapshot-schema"
import { SessionHistory } from "./history"
import { publishCompareKey, decideSessionPublish } from "./publish-dedup"
import { PartWriteBuffer } from "./part-write-buffer"
import { Config } from "@/config/config"
import { ControlProfileCompiler } from "@/control-profile/compiler"
import type { ProfileId } from "@/control-profile/types"

import type { Provider } from "@/provider/provider"
import { PermissionNext } from "@/permission/next"
import { SessionInteraction } from "./interaction"
import { SessionManager } from "./manager"
import { SessionEvent } from "./event"
import { Info as InfoSchema, StatusInfo as StatusInfoSchema } from "./types"
import type {
  Info as InfoType,
  StatusInfo as StatusInfoType,
  WorkingInfo as WorkingInfoType,
  CortexDelegationInfo as CortexDelegationInfoType,
  SuperPlanSessionInfo as SuperPlanSessionInfoType,
} from "./types"
import { SessionNav, type SessionNavEntry } from "./nav"
import { SessionEndpoint } from "./endpoint"
import { createDefaultTitle } from "./title"
import * as SessionWorking from "./working"

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
    const { working: _working, ...rest } = session
    return rest
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

  export type ChildIndexEntry = {
    id: string
    title: string
    updated: number
    created: number
    archived: boolean
  }

  export type ChildIndex = {
    version: 1
    scopeID: string
    parentID: string
    updatedAt: number
    entries: ChildIndexEntry[]
  }

  export const ChildCursor = z
    .object({
      lastActivityAt: z.number(),
      id: z.string(),
    })
    .meta({ ref: "SessionChildCursor" })

  export const ChildrenPage = z
    .object({
      items: Info.array(),
      nextCursor: ChildCursor.nullable(),
      total: z.number(),
    })
    .meta({ ref: "SessionChildrenPage" })

  export type ChildCursor = z.infer<typeof ChildCursor>
  export type ChildrenPage = z.infer<typeof ChildrenPage>

  export const WorkspaceSelection = z
    .discriminatedUnion("mode", [
      z.object({
        mode: z.literal("current"),
      }),
      z.object({
        mode: z.literal("existing"),
        target: z.string().min(1),
        force: z.boolean().optional(),
      }),
      z.object({
        mode: z.literal("create"),
        name: z.string().optional(),
        baseRef: z.enum(["current", "fresh"]).optional(),
        baseRevision: z.string().min(1).optional(),
      }),
    ])
    .meta({ ref: "SessionWorkspaceSelection" })
  export type WorkspaceSelection = z.infer<typeof WorkspaceSelection>

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

  function toChildIndexEntry(session: Info): ChildIndexEntry {
    return {
      id: session.id,
      title: session.title,
      updated: session.time.updated,
      created: session.time.created,
      archived: !!session.time.archived,
    }
  }

  function sortChildIndexEntries(entries: ChildIndexEntry[]) {
    entries.sort((a, b) => b.updated - a.updated || b.id.localeCompare(a.id))
  }

  export async function readChildIndex(scopeID: string, parentID: string): Promise<ChildIndex> {
    return Storage.read<ChildIndex>(StoragePath.sessionChildIndex(asScopeID(scopeID), asSessionID(parentID))).catch(
      () => ({
        version: 1,
        scopeID,
        parentID,
        updatedAt: 0,
        entries: [],
      }),
    )
  }

  export async function writeChildIndex(scopeID: string, parentID: string, index: ChildIndex) {
    sortChildIndexEntries(index.entries)
    await Storage.write(StoragePath.sessionChildIndex(asScopeID(scopeID), asSessionID(parentID)), {
      ...index,
      updatedAt: Date.now(),
    })
  }

  export async function upsertChildIndexEntry(scopeID: string, parentID: string, entry: ChildIndexEntry) {
    const index = await readChildIndex(scopeID, parentID)
    const existing = index.entries.findIndex((e) => e.id === entry.id)
    if (existing >= 0) index.entries.splice(existing, 1)
    index.entries.push(entry)
    await writeChildIndex(scopeID, parentID, index)
  }

  export async function removeChildIndexEntry(scopeID: string, parentID: string, sessionID: string) {
    const index = await readChildIndex(scopeID, parentID)
    const nextEntries = index.entries.filter((e) => e.id !== sessionID)
    if (nextEntries.length === index.entries.length) return
    index.entries = nextEntries
    await writeChildIndex(scopeID, parentID, index)
  }

  export async function removeChildIndex(scopeID: string, parentID: string) {
    await Storage.remove(StoragePath.sessionChildIndex(asScopeID(scopeID), asSessionID(parentID)))
  }

  function toNavEntry(session: Info): SessionNavEntry {
    const scope = session.scope as Scope
    const scopeType = scope.type === "home" ? "home" : "project"
    const category =
      session.category ??
      SessionNav.deriveCategory({
        scopeType,
        endpointKind: session.endpoint?.kind,
        parentID: session.parentID,
        cortex: session.cortex,
        agenda: session.agenda,
      })
    return {
      id: session.id,
      scopeID: scope.id,
      scopeType,
      title: session.title,
      category,
      lastActivityAt: session.time.updated,
      pinned: session.pinned ?? 0,
      archived: !!session.time.archived,
      parentID: session.parentID,
      endpointKind: session.endpoint?.kind === "channel" ? "channel" : undefined,
      chatId: session.endpoint?.kind === "channel" ? session.endpoint.channel?.chatId : undefined,
      chatName: session.endpoint?.kind === "channel" ? session.endpoint.channel?.chatName : undefined,
      chatType: session.endpoint?.kind === "channel" ? session.endpoint.channel?.chatType : undefined,
      completionNotice: {
        unread: session.completionNotice.unread,
      },
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

  export async function withRuntimeInfo(session: Info): Promise<Info & { working?: WorkingInfoType }> {
    const [working, history] = await Promise.all([
      SessionWorking.resolve(session.id),
      session.history?.rollback ? SessionHistory.storedInfo(session.id).catch(() => session.history) : session.history,
    ])
    const result = { ...withoutRuntimeInfo(session), history }
    if (!working) return result
    return { ...result, working }
  }

  // Dedup redundant session.updated publishes: a diff limited to time.updated
  // (or a byte-identical payload) is throttled to a heartbeat, while any real
  // field change publishes immediately (issue #319, defense in depth).
  const lastPublish = new Map<string, { key: string; at: number }>()
  const PUBLISH_DEDUP_THROTTLE_MS = 1000

  async function publishInfo(event: typeof SessionEvent.Updated, session: Info) {
    const info = await withRuntimeInfo(session)
    const key = publishCompareKey(info)
    const now = Date.now()
    const prev = lastPublish.get(session.id)
    if (
      !decideSessionPublish({
        prevKey: prev?.key,
        prevAt: prev?.at,
        nextKey: key,
        now,
        throttleMs: PUBLISH_DEDUP_THROTTLE_MS,
      })
    ) {
      return
    }
    if (info.time.archived) lastPublish.delete(session.id)
    else lastPublish.set(session.id, { key, at: now })
    Bus.publish(event, { info })
  }

  export async function create(input?: {
    scope?: Scope
    parentID?: string
    title?: string
    permission?: PermissionNext.Ruleset
    controlProfile?: Info["controlProfile"]
    preAuthorizedActions?: string[]
    endpoint?: SessionEndpoint.Info
    id?: string
    agenda?: { itemID: string }
    interaction?: SessionInteraction.Info
    cortex?: CortexDelegationInfoType
    superplan?: SuperPlanSessionInfoType
    workspace?: import("./types").Workspace
    forkedFrom?: Info["forkedFrom"]
    completionNotice?: {
      silent?: boolean
    }
  }) {
    const scope = input?.scope ?? ScopeContext.current.scope
    const parent = input?.parentID ? await SessionManager.getSession(input.parentID) : undefined
    const workspace: import("./types").Workspace = input?.workspace ??
      parent?.workspace ?? {
        type: "main" as const,
        path: scope.directory,
        scopeID: scope.id,
      }
    const inheritedInteraction = input?.interaction ?? parent?.interaction
    const controlProfile = input?.parentID ? undefined : input?.controlProfile
    const completionNotice = {
      unread: false,
      silent: input?.completionNotice?.silent ?? parent?.completionNotice.silent ?? false,
    }

    const endpoint = input?.endpoint
    const createdAt = Date.now()
    const scopeType = scope.type === "home" ? "home" : "project"
    const category = SessionNav.deriveCategory({
      scopeType,
      endpointKind: endpoint?.kind,
      parentID: input?.parentID,
      cortex: input?.cortex,
      agenda: input?.agenda,
    })

    const result: Info = {
      id: Identifier.descending("session", input?.id),
      version: Installation.VERSION,
      scope,
      parentID: input?.parentID,
      forkedFrom: input?.forkedFrom,
      category,
      title: input?.title ?? createDefaultTitle(!!input?.parentID),
      permission: input?.permission,
      controlProfile,
      preAuthorizedActions: input?.preAuthorizedActions,
      endpoint,
      interaction: inheritedInteraction,
      agenda: input?.agenda,
      cortex: input?.cortex,
      superplan: input?.superplan,
      workspace,
      completionNotice,
      time: {
        created: createdAt,
        updated: createdAt,
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
    if (result.parentID) await upsertChildIndexEntry(scope.id, result.parentID, toChildIndexEntry(result))
    await SessionNav.upsertNavEntry(toNavEntry(result))

    if (result.agenda) {
      await Storage.write(StoragePath.agendaSession(result.agenda.itemID, result.id), {
        sessionID: result.id,
        scopeID: scope.id,
      })
    }

    SessionManager.registerRuntime(result.id)
    Scope.touch(scope.id)

    await publishInfo(SessionEvent.Updated, result)
    return withRuntimeInfo(result)
  }

  export async function applyWorkspaceSelection(
    sessionID: string,
    selection?: WorkspaceSelection,
  ): Promise<Info & { working?: WorkingInfoType }> {
    if (!selection || selection.mode === "current") return get(sessionID)

    const { Worktree } = await import("../project/worktree")
    if (selection.mode === "create") {
      await Worktree.create({
        sessionID,
        name: selection.name,
        baseRef: selection.baseRef ?? "current",
        baseRevision: selection.baseRevision,
        bind: true,
      })
      return get(sessionID)
    }

    await Worktree.enter({
      sessionID,
      target: selection.target,
      force: selection.force ?? false,
    })
    return get(sessionID)
  }

  export const fork = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message").optional(),
      position: z
        .discriminatedUnion("type", [
          z.object({
            type: z.literal("current"),
          }),
          z.object({
            type: z.literal("before"),
            messageID: Identifier.schema("message"),
          }),
        ])
        .optional(),
      workspace: WorkspaceSelection.optional(),
      title: z.string().optional(),
      controlProfile: z.enum(["guarded", "autonomous", "full_access"]).optional(),
    }),
    async (input) => {
      const source = await SessionManager.requireSession(input.sessionID)
      const forkPoint = input.position?.type === "before" ? input.position.messageID : input.messageID
      let session = await create({
        scope: source.scope as Scope,
        workspace: source.workspace,
        title: input.title,
        controlProfile: input.controlProfile ?? (await resolveControlProfile(source.id)),
        forkedFrom: {
          sessionID: source.id,
          messageID: forkPoint,
          title: source.title,
        },
      })
      const msgs = await messages({ sessionID: input.sessionID })
      const messageMap = new Map<string, string>()
      for (const msg of msgs) {
        if (forkPoint && msg.info.id >= forkPoint) break
        const id = Identifier.ascending("message")
        messageMap.set(msg.info.id, id)
        const cloned = await updateMessage({
          ...msg.info,
          sessionID: session.id,
          id,
          ...("parentID" in msg.info && typeof msg.info.parentID === "string"
            ? { parentID: messageMap.get(msg.info.parentID) ?? msg.info.parentID }
            : {}),
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

      try {
        session = await applyWorkspaceSelection(session.id, input.workspace)
      } catch (error) {
        await remove(session.id)
        throw error
      }
      return session
    },
  )
  export const touch = fn(Identifier.schema("session"), async (sessionID) => {
    await update(sessionID, (draft) => {
      draft.time.updated = Date.now()
    })
  })

  export async function updateWorkspace(sessionID: string, workspace: import("./types").Workspace): Promise<Info> {
    return update(sessionID, (draft) => {
      draft.workspace = workspace
    })
  }

  export async function updateControlProfile(
    sessionID: string,
    controlProfile: NonNullable<Info["controlProfile"]>,
    editor?: (session: Info) => void,
  ): Promise<Info> {
    SessionManager.assertIdle(sessionID)

    const updated = await update(sessionID, (draft) => {
      draft.controlProfile = controlProfile
      editor?.(draft)
    })

    return updated
  }

  async function sessionControlProfileState(
    sessionID: string,
  ): Promise<{ controlProfile?: Info["controlProfile"]; root: Info }> {
    let currentID = sessionID
    while (true) {
      const session = await SessionManager.requireSession(currentID)
      const scope = session.scope as Scope
      const info =
        (await Storage.read<Info>(StoragePath.sessionInfo(asScopeID(scope.id), asSessionID(currentID)))) ?? session
      if (info.controlProfile) return { controlProfile: info.controlProfile, root: info }
      if (!info.parentID) return { root: info }
      currentID = info.parentID
    }
  }

  export function defaultControlProfileForSessionSource(session?: Pick<Info, "endpoint" | "agenda">): ProfileId {
    if (session?.endpoint?.kind === "channel") return "autonomous"
    if (session?.agenda) return "autonomous"
    return "guarded"
  }

  export async function resolveSessionControlProfile(sessionID: string): Promise<Info["controlProfile"] | undefined> {
    return (await sessionControlProfileState(sessionID)).controlProfile
  }

  export async function resolveEffectiveControlProfile(input: {
    sessionID?: string
    agentControlProfile?: string
    topLevelControlProfile?: string
  }): Promise<ProfileId> {
    const sessionState = input.sessionID ? await sessionControlProfileState(input.sessionID) : undefined
    if (sessionState?.controlProfile) return ControlProfileCompiler.normalize(sessionState.controlProfile)
    if (input.agentControlProfile) return ControlProfileCompiler.normalize(input.agentControlProfile)

    const topLevelProfile =
      input.topLevelControlProfile ??
      (await Config.current()
        .then((cfg) => cfg.controlProfile)
        .catch(() => undefined))
    if (topLevelProfile) return ControlProfileCompiler.normalize(topLevelProfile)

    return defaultControlProfileForSessionSource(sessionState?.root)
  }

  export async function resolveControlProfile(sessionID: string): Promise<NonNullable<Info["controlProfile"]>> {
    return resolveEffectiveControlProfile({ sessionID })
  }

  export const get = fn(Identifier.schema("session"), async (id) => {
    const session = await SessionManager.requireSession(id)
    const scope = session.scope as Scope
    const read = await Storage.read<Info>(StoragePath.sessionInfo(asScopeID(scope.id), asSessionID(id)))
    const info = read as Info
    if (info.parentID && !info.controlProfile) {
      info.controlProfile = await resolveControlProfile(id)
    }
    return withRuntimeInfo(info)
  })

  export async function clearCompletionNotice(id: string) {
    const session = await SessionManager.requireSession(id)
    const scope = session.scope as Scope
    const key = StoragePath.sessionInfo(asScopeID(scope.id), asSessionID(id))
    const before = await Storage.read<Info>(key)
    if (!before.completionNotice.unread) return withRuntimeInfo(before)

    const result = await Storage.update<Info>(key, (draft) => {
      draft.completionNotice.unread = false
    })

    await SessionNav.upsertNavEntry(toNavEntry(result))
    await publishInfo(SessionEvent.Updated, result)
    return withRuntimeInfo(result)
  }

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
    if (before.parentID && before.parentID !== result.parentID) {
      await removeChildIndexEntry(scope.id, before.parentID, result.id)
    }
    if (result.parentID) {
      await upsertChildIndexEntry(scope.id, result.parentID, toChildIndexEntry(result))
    }
    await SessionNav.upsertNavEntry(toNavEntry(result), {
      preserveActivityAt: before.pendingReply === true && result.pendingReply === true,
    })

    const beforeKey = before.endpoint ? SessionEndpoint.toKey(before.endpoint) : undefined
    const afterKey = result.endpoint ? SessionEndpoint.toKey(result.endpoint) : undefined
    if (beforeKey && beforeKey !== afterKey) {
      await removeEndpointIndex(before)
    }
    if (result.endpoint) {
      await writeEndpointIndex(result)
    }

    if (!before.time.archived && result.time.archived) {
      const { Worktree } = await import("../project/worktree")
      await Worktree.detachSession(result.id).catch((error) => {
        log.warn("failed to detach worktree during session archive", { sessionID: result.id, error })
      })
    }
    await publishInfo(SessionEvent.Updated, result)
    return withRuntimeInfo(result)
  }

  export const diff = fn(Identifier.schema("session"), async (sessionID) => {
    const session = await SessionManager.requireSession(sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    const diffs = await Storage.read<SnapshotSchema.FileDiff[]>(
      StoragePath.sessionSummary(scopeID, asSessionID(sessionID)),
    )
    return diffs ?? []
  })

  export const messages = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      limit: z.number().optional(),
      raw: z.boolean().optional(),
    }),
    async (input) => {
      return SessionHistory.messages(input)
    },
  )

  export const rollback = SessionHistory.rollback
  export const unrollback = SessionHistory.unrollback
  export const restoreFiles = SessionHistory.restoreFiles

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
    const scopeID = asScopeID(ScopeContext.current.scope.id)
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
      const data = await Promise.all(matched.slice(offset, offset + limit).map((s) => withRuntimeInfo(s)))
      return { data, total }
    }

    const total = entries.length
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? total
    const slice = entries.slice(offset, offset + limit)

    if (slice.length === 0) return { data: [], total }

    const keys = slice.map((e) => StoragePath.sessionInfo(scopeID, asSessionID(e.id)))
    const sessions = await Storage.readMany<Info>(keys)
    const data = await Promise.all(
      sessions.filter((s): s is Info => s != null && !!s.scope).map((s) => withRuntimeInfo(s)),
    )

    return { data, total }
  }

  export async function* listAll() {
    const scopeID = asScopeID(ScopeContext.current.scope.id)
    const ids = await Storage.scan(StoragePath.sessionsRoot(scopeID))
    const keys = ids.map((id) => StoragePath.sessionInfo(scopeID, asSessionID(id)))
    const sessions = await Storage.readMany<Info>(keys)
    for (const session of sessions) {
      if (session && session.scope) yield session as Info
    }
  }

  async function queryChildren(input: {
    parentID: string
    cursor?: ChildCursor | null
    limit?: number
    search?: string
    includeArchived?: boolean
  }): Promise<ChildrenPage> {
    const parent = await SessionManager.requireSession(input.parentID)
    const scope = parent.scope as Scope
    const index = await readChildIndex(scope.id, input.parentID)
    let entries = index.entries

    if (!input.includeArchived) entries = entries.filter((entry) => !entry.archived)

    const search = input.search?.trim().toLowerCase()
    if (search) {
      entries = entries.filter((entry) => entry.title.toLowerCase().includes(search))
    }

    const total = entries.length
    let startIdx = 0
    if (input.cursor) {
      const cursor = input.cursor
      startIdx = entries.findIndex(
        (entry) =>
          entry.updated < cursor.lastActivityAt || (entry.updated === cursor.lastActivityAt && entry.id < cursor.id),
      )
      if (startIdx === -1) startIdx = entries.length
    }

    const limit = input.limit ?? total
    const slice = entries.slice(startIdx, startIdx + limit)
    const hasMore = startIdx + slice.length < total
    const last = slice.at(-1)
    const nextCursor = hasMore && last ? { lastActivityAt: last.updated, id: last.id } : null

    const keys = slice.map((entry) => StoragePath.sessionInfo(asScopeID(scope.id), asSessionID(entry.id)))
    const sessions = await Storage.readMany<Info>(keys)
    const items = await Promise.all(
      sessions
        .filter((session): session is Info => session != null && !!session.scope)
        .map((session) => withRuntimeInfo(session)),
    )

    return { items, nextCursor, total }
  }

  export const childPage = fn(
    z.object({
      parentID: Identifier.schema("session"),
      cursor: ChildCursor.nullable().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      search: z.string().optional(),
      includeArchived: z.boolean().optional(),
    }),
    queryChildren,
  )

  export const children = fn(Identifier.schema("session"), async (parentID) => {
    const page = await queryChildren({ parentID, includeArchived: true })
    return page.items
  })

  export const remove = fn(Identifier.schema("session"), async (sessionID) => {
    try {
      const session = await get(sessionID)
      const scope = session.scope as Scope
      const scopeID = asScopeID(scope.id)
      for (const child of await children(sessionID)) {
        await remove(child.id)
      }
      const { Worktree } = await import("../project/worktree")
      await Worktree.detachSession(sessionID).catch((error) => {
        log.warn("failed to detach worktree during session removal", { sessionID, error })
      })
      SessionManager.unregisterRuntime(sessionID)
      SessionManager.forgetSession(sessionID)
      await removeEndpointIndex(session)
      await Storage.removeTree(StoragePath.sessionRoot(scopeID, asSessionID(sessionID)))
      await Storage.remove(StoragePath.sessionIndex(asSessionID(sessionID)))
      await removePageIndexEntry(scope.id, sessionID)
      if (session.parentID) await removeChildIndexEntry(scope.id, session.parentID, sessionID)
      await removeChildIndex(scope.id, sessionID)
      await SessionNav.removeNavEntry(scope.id, sessionID)
      await Bus.publish(SessionEvent.Deleted, {
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
    const msgs = await messages({ sessionID })
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
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
    const canonical = MessageV2.canonicalMessage(msg)
    const session = await SessionManager.requireSession(msg.sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    await Storage.write(
      StoragePath.messageInfo(scopeID, asSessionID(canonical.sessionID), asMessageID(canonical.id)),
      canonical,
    )
    Bus.publish(MessageV2.Event.Updated, {
      info: canonical,
    })
    return canonical
  })

  export const mergeMessageMetadata = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
      metadata: z.record(z.string(), z.any()),
    }),
    async (input) => {
      const session = await SessionManager.requireSession(input.sessionID)
      const scopeID = asScopeID((session.scope as Scope).id)
      const result = await Storage.update<MessageV2.Info>(
        StoragePath.messageInfo(scopeID, asSessionID(input.sessionID), asMessageID(input.messageID)),
        (draft) => {
          draft.metadata = {
            ...draft.metadata,
            ...input.metadata,
          }
        },
      )
      Bus.publish(MessageV2.Event.Updated, {
        info: result,
      })
      return result
    },
  )

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

  // Write-behind for streaming part persistence (perf hotspot S1). Text/reasoning
  // deltas are coalesced to at most one disk write per interval; discrete updates
  // (tool state, the final no-delta part write) persist immediately so nothing is
  // lost at a meaningful boundary. The event is always broadcast on every delta.
  const partWriteBuffer = new PartWriteBuffer<MessageV2.Part, string[]>((path, value) => Storage.write(path, value))

  /**
   * Flush all buffered streaming part writes to disk and await them. Called at
   * turn finalization so the persisted parts reflect everything streamed — most
   * importantly when a turn is interrupted mid-stream and the terminal part
   * write that normally flushes never fired (issue #327).
   */
  export function flushPartWrites() {
    return partWriteBuffer.flushAll()
  }

  export const updatePart = fn(UpdatePartInput, async (input) => {
    const part = MessageV2.canonicalPart("delta" in input ? input.part : input)
    const delta = "delta" in input ? input.delta : undefined
    // Streaming hot path (issue #350 H1): resolve the scopeID from the permanent
    // sessionID -> scopeID cache instead of loading full session info on every
    // delta. A session's scope is immutable, so this is safe; on a cold cache it
    // reads only the small session-index record.
    const scopeID = asScopeID(await SessionManager.resolveScopeID(part.sessionID))
    const path = StoragePath.messagePart(
      scopeID,
      asSessionID(part.sessionID),
      asMessageID(part.messageID),
      asPartID(part.id),
    )
    if (delta !== undefined) {
      partWriteBuffer.defer(part.id, path, part)
    } else {
      // Discrete/terminal update: cancel any pending streamed write and persist
      // durably before returning (preserves the original write-through contract).
      partWriteBuffer.cancel(part.id)
      await Storage.write(path, part)
    }
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
      const providerCacheHitTokens = providerMetadataNumber(input.metadata, [
        ["deepseek", "prompt_cache_hit_tokens"],
        ["openaiCompatible", "prompt_cache_hit_tokens"],
        ["openai-compatible", "prompt_cache_hit_tokens"],
        ["openai", "prompt_cache_hit_tokens"],
      ])
      const providerCacheMissTokens = providerMetadataNumber(input.metadata, [
        ["deepseek", "prompt_cache_miss_tokens"],
        ["openaiCompatible", "prompt_cache_miss_tokens"],
        ["openai-compatible", "prompt_cache_miss_tokens"],
        ["openai", "prompt_cache_miss_tokens"],
      ])
      const cachedInputTokens = input.usage.cachedInputTokens ?? providerCacheHitTokens ?? 0
      const excludesCachedTokens = !!(input.metadata?.["anthropic"] || input.metadata?.["bedrock"])
      const safe = (value: number) => {
        if (!Number.isFinite(value)) return 0
        return value
      }
      const adjustedInputTokens =
        providerCacheMissTokens ??
        (excludesCachedTokens ? (input.usage.inputTokens ?? 0) : (input.usage.inputTokens ?? 0) - cachedInputTokens)

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

  function providerMetadataNumber(metadata: ProviderMetadata | undefined, paths: string[][]): number | undefined {
    for (const path of paths) {
      let current: unknown = metadata
      for (const segment of path) {
        if (!current || typeof current !== "object") {
          current = undefined
          break
        }
        current = (current as Record<string, unknown>)[segment]
      }
      if (typeof current === "number" && Number.isFinite(current)) return current
    }
    return undefined
  }

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
      const existingChatName = existing.endpoint?.kind === "channel" ? existing.endpoint.channel?.chatName : undefined
      const newChatName = endpoint.kind === "channel" ? endpoint.channel.chatName : undefined
      const isPlatformID = (name: string | undefined): boolean => !!name && /^(ou_|on_|oc_|user_)/.test(name)
      const chatNameChanged =
        (newChatName != null && existingChatName !== newChatName) ||
        (isPlatformID(existingChatName) && newChatName == null)
      if (chatNameChanged) {
        return update(existing.id, (draft) => {
          if (draft.endpoint?.kind === "channel") {
            draft.endpoint.channel.chatName = newChatName
          }
          if (interaction && draft.interaction?.mode !== interaction.mode) {
            draft.interaction = interaction
          }
        })
      }
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

  export async function deliver(input: {
    target: string | SessionEndpoint.Info
    mail: SessionManager.SessionMail
    waitForProcessing?: boolean
  }) {
    await SessionManager.deliver(input)
  }
}

MessageV2.installSessionResolver((sessionID) => SessionManager.requireSession(sessionID))
