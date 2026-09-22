import { Workspace } from "./workspace-schema"
import { WorkspaceBinding } from "../workspace/binding"
import { WorkspaceCatalog } from "../workspace/catalog"
import { SessionRecords } from "./records"
import { WorkspaceAccess } from "../workspace/access"
import { RuntimeContext } from "../lifecycle/context"
import type { StoreTransaction } from "../storage/transactional-store"
import { StorageIntegrityError } from "../storage/errors"
import { SessionStaging } from "./staging"
import { RolloutAttachment } from "./rollout/attachment"
import { RolloutContext } from "./rollout/context"
import { SnapshotLifecycle } from "./snapshot-lifecycle"
import { SnapshotRecords } from "./snapshot-records"
import { Decimal } from "decimal.js"
import { RolloutArtifact } from "./rollout/artifact"
import { record, RolloutRecordingError } from "./rollout/error"
import { z } from "zod"
import { type LanguageModelUsage, type ProviderMetadata } from "ai"
import { Identifier } from "../id/id"
import { Installation } from "../global/installation"
import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"
import { NamedError } from "@ericsanchezok/synergy-util/error"

import { Bus } from "../bus"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Log } from "../util/log"
import { Lock } from "../util/lock"
import { MessageV2 } from "./message-v2"
import { ScopeContext } from "../scope/context"
import { Scope } from "../scope"
import { fn } from "../util/fn"
import { workMap } from "../util/queue"
import { Snapshot } from "./snapshot"
import { SnapshotSchema } from "./snapshot-schema"
import { SessionHistory } from "./history"
import { publishCompareKey, decideSessionPublish } from "./publish-dedup"
import { PartWriteBuffer } from "./part-write-buffer"
import { SessionCompat } from "./compat-import"
import { Config } from "../config/config"
import { ControlProfileCompiler } from "../control-profile/compiler"
import type { ProfileId } from "../control-profile/types"

import type { Provider } from "../provider/provider"
import { PermissionNext } from "../permission/next"
import { SessionInteraction } from "./interaction"
import { SessionManager } from "./manager"
import { SessionMessageCache } from "./message-cache"
import { SessionEvent } from "./event"
import {
  Info as InfoSchema,
  normalizeSessionTags,
  PersistedInfo as PersistedInfoSchema,
  RollbackAck as RollbackAckSchema,
  StatusInfo as StatusInfoSchema,
  TagQuery as TagQuerySchema,
  Tags as TagsSchema,
} from "./types"
import type {
  Info as InfoType,
  RollbackAck as RollbackAckType,
  StatusInfo as StatusInfoType,
  WorkingInfo as WorkingInfoType,
  CortexDelegationInfo as CortexDelegationInfoType,
  SessionCreationExtensions,
} from "./types"
import { SessionNav, type SessionNavEntry } from "./nav"
import { SessionEndpoint } from "./endpoint"
import { createDefaultTitle } from "./title"
import * as SessionWorking from "./working"
import { SessionSchemaRegistry } from "./schema-registry"
import { SessionMutation } from "./mutation"
import { SessionWorkspaceRuntime } from "./workspace-runtime"
import { SessionSearchIndex } from "./search-index"

export namespace Session {
  export const Info = InfoSchema
  export const PersistedInfo = PersistedInfoSchema
  export const StatusInfo = StatusInfoSchema
  export const TagQuery = TagQuerySchema
  export const Tags = TagsSchema
  export const RollbackAck = RollbackAckSchema
  export type RollbackAck = RollbackAckType

  export const RollbackAckConflictError = NamedError.create(
    "SessionRollbackAckConflictError",
    z.object({
      message: z.string(),
      rollbackID: Identifier.schema("history"),
      currentRollbackID: Identifier.schema("history").optional(),
    }),
  )
  export type Info = InfoType
  export type StatusInfo = StatusInfoType

  export const EndpointScopeMismatchError = NamedError.create(
    "SessionEndpointScopeMismatchError",
    z.object({
      sessionID: z.string(),
      existingScopeID: z.string(),
      requestedScopeID: z.string(),
    }),
  )

  export const EndpointSessionArchivedError = NamedError.create(
    "SessionEndpointSessionArchivedError",
    z.object({ sessionID: z.string() }),
  )

  export const ForkPointMissingError = NamedError.create(
    "SessionForkPointMissingError",
    z.object({
      sessionID: z.string(),
      messageID: z.string(),
      message: z.string(),
    }),
  )

  const log = Log.create({ service: "session" })
  const { asScopeID, asSessionID, asMessageID, asPartID } = Identifier

  const FORK_PREPARE_CONCURRENCY = 8

  export function toIndex(session: Info) {
    const scope = session.scope as Scope
    return {
      sessionID: session.id,
      scopeID: scope.id,
      directory: scope.local?.directory,
      parentID: session.parentID,
      endpoint: session.endpoint,
      endpointKey: session.endpoint ? SessionEndpoint.toKey(session.endpoint) : undefined,
    }
  }

  export function indexEndpoint(endpoint: unknown, archived?: number): SessionEndpoint.Info | undefined {
    const retiredEndpoint = z.object({ kind: z.literal("holos"), agentId: z.string() })
    if (retiredEndpoint.safeParse(endpoint).success) {
      if (!archived)
        throw new StorageIntegrityError("Retired Session endpoint must be archived before rebuilding indexes")
      return undefined
    }
    if (endpoint === undefined) return
    const historical = z
      .object({ kind: z.literal("channel"), channel: z.record(z.string(), z.unknown()) })
      .parse(endpoint)
    return SessionEndpoint.Info.parse({
      ...historical,
      channel: Object.fromEntries(Object.entries(historical.channel).filter(([, value]) => value !== null)),
    })
  }

  export async function rebuildStorageIndexes(tx: StoreTransaction) {
    for (const root of [
      "session_index",
      "endpoint_session",
      "sessions_page_index",
      "session_child_index",
      "session_nav_v2",
    ])
      await tx.removeTree([root])
    const scopes = await tx.scan(["sessions"])
    for (const scopeID of scopes) {
      const page: PageIndex = { entries: [] }
      const children = new Map<string, ChildIndex>()
      const nav: SessionNavEntry[] = []
      let after: string[] | undefined
      for (;;) {
        const batch = await tx.query<Info>({ kind: "session", scopeID, after, limit: 128 })
        if (!batch.length) break
        for (const record of batch) {
          const session = await SessionRecords.hydrate(
            {
              ...record.value,
              endpoint: indexEndpoint(record.value.endpoint, record.value.time.archived),
            },
            tx,
          )
          const index = toIndex(session)
          if (index.scopeID !== scopeID || session.id !== record.key[2])
            throw new Error("Session identity does not match its storage owner")
          await tx.write(["session_index", session.id], index)
          if (session.endpoint)
            await tx.write(
              StoragePath.endpointSession(SessionEndpoint.toKey(session.endpoint), asSessionID(session.id)),
              { sessionID: session.id, scopeID },
            )
          page.entries.push(toPageIndexEntry(session))
          nav.push(toNavEntry(session))
          if (session.parentID) {
            const child = children.get(session.parentID) ?? {
              version: 1,
              scopeID,
              parentID: session.parentID,
              updatedAt: Date.now(),
              entries: [],
            }
            child.entries.push(toChildIndexEntry(session))
            children.set(session.parentID, child)
          }
        }
        after = batch.at(-1)!.key
      }
      page.entries.sort((a, b) => b.updated - a.updated || b.id.localeCompare(a.id))
      nav.sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id))
      await tx.write(["sessions_page_index", scopeID], page)
      await tx.write(["session_nav_v2", scopeID], { version: 1, scopeID, updatedAt: Date.now(), entries: nav })
      for (const [parentID, child] of children) {
        sortChildIndexEntries(child.entries)
        await tx.write(["session_child_index", scopeID, parentID], child)
      }
    }
    await tx.remove(StoragePath.rolloutRecoveryPending())
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
      z.object({ mode: z.literal("none") }),
      z.object({
        mode: z.literal("current"),
      }),
      z.object({
        mode: z.literal("workspace"),
        workspaceID: z.string().min(1),
        workspaceGeneration: z.number().int().positive(),
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

  async function readStoredPageIndex(scopeID: string): Promise<PageIndex> {
    const index = await Storage.read<PageIndex>(StoragePath.sessionsPageIndex(asScopeID(scopeID))).catch((error) => {
      if (error instanceof Storage.NotFoundError) return { entries: [] }
      throw error
    })
    return index
  }

  export async function readPageIndex(scopeID: string): Promise<PageIndex> {
    return SessionCompat.mergePageIndex(scopeID, await readStoredPageIndex(scopeID))
  }

  export async function writePageIndex(scopeID: string, index: PageIndex) {
    await Storage.write(StoragePath.sessionsPageIndex(asScopeID(scopeID)), index)
  }

  export async function upsertPageIndexEntry(scopeID: string, entry: PageIndex["entries"][number]) {
    return Storage.transaction(async () => {
      const index = await readStoredPageIndex(scopeID)
      const existing = index.entries.findIndex((e) => e.id === entry.id)
      if (existing >= 0) index.entries.splice(existing, 1)
      const insertAt = index.entries.findIndex((e) => e.updated <= entry.updated)
      if (insertAt === -1) index.entries.push(entry)
      else index.entries.splice(insertAt, 0, entry)
      await writePageIndex(scopeID, index)
    })
  }

  export async function removePageIndexEntry(scopeID: string, sessionID: string) {
    return Storage.transaction(async () => {
      const index = await readStoredPageIndex(scopeID)
      index.entries = index.entries.filter((e) => e.id !== sessionID)
      await writePageIndex(scopeID, index)
    })
  }

  export function toPageIndexEntry(session: Info): PageIndex["entries"][number] {
    return {
      id: session.id,
      updated: session.time.updated,
      created: session.time.created,
      pinned: session.pinned ?? 0,
      archived: !!session.time.archived,
      parentID: session.parentID,
    }
  }

  export function toChildIndexEntry(session: Info): ChildIndexEntry {
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

  async function readStoredChildIndex(scopeID: string, parentID: string): Promise<ChildIndex> {
    const index = await Storage.read<ChildIndex>(
      StoragePath.sessionChildIndex(asScopeID(scopeID), asSessionID(parentID)),
    ).catch((error): ChildIndex => {
      if (error instanceof Storage.NotFoundError) return { version: 1, scopeID, parentID, updatedAt: 0, entries: [] }
      throw error
    })
    return index
  }

  export async function readChildIndex(scopeID: string, parentID: string): Promise<ChildIndex> {
    return SessionCompat.mergeChildIndex(scopeID, parentID, await readStoredChildIndex(scopeID, parentID))
  }

  export async function writeChildIndex(scopeID: string, parentID: string, index: ChildIndex) {
    sortChildIndexEntries(index.entries)
    await Storage.write(StoragePath.sessionChildIndex(asScopeID(scopeID), asSessionID(parentID)), {
      ...index,
      updatedAt: Date.now(),
    })
  }

  export async function upsertChildIndexEntry(scopeID: string, parentID: string, entry: ChildIndexEntry) {
    return Storage.transaction(async () => {
      const index = await readStoredChildIndex(scopeID, parentID)
      const existing = index.entries.findIndex((e) => e.id === entry.id)
      if (existing >= 0) index.entries.splice(existing, 1)
      index.entries.push(entry)
      await writeChildIndex(scopeID, parentID, index)
    })
  }

  export async function removeChildIndexEntry(scopeID: string, parentID: string, sessionID: string) {
    return Storage.transaction(async () => {
      const index = await readStoredChildIndex(scopeID, parentID)
      const nextEntries = index.entries.filter((e) => e.id !== sessionID)
      if (nextEntries.length === index.entries.length) return
      index.entries = nextEntries
      await writeChildIndex(scopeID, parentID, index)
    })
  }

  export async function removeChildIndex(scopeID: string, parentID: string) {
    await Storage.remove(StoragePath.sessionChildIndex(asScopeID(scopeID), asSessionID(parentID)))
  }

  export function toNavEntry(session: Info): SessionNavEntry {
    const scope = session.scope as Scope
    const scopeType = scope.type === "home" ? "home" : "project"
    const channelEndpoint = session.endpoint?.kind === "channel" ? session.endpoint.channel : undefined
    const category =
      session.category ??
      SessionNav.deriveCategory({
        scopeType,
        endpointKind: session.endpoint?.kind,
        provenance: session.provenance,
        parentID: session.parentID,
        cortex: session.cortex,
        background: SessionSchemaRegistry.isBackground(session),
      })
    return {
      id: session.id,
      scopeID: scope.id,
      scopeType,
      title: session.title,
      tags: session.tags,
      category,
      lastActivityAt: session.time.updated,
      createdAt: session.time.created,
      updatedAt: session.time.updated,
      pinned: session.pinned ?? 0,
      archived: !!session.time.archived,
      archivedAt: session.time.archived || undefined,
      parentID: session.parentID,
      ...SessionNav.deriveSessionIdentity(session),
      endpointKind: channelEndpoint ? "channel" : undefined,
      chatId: channelEndpoint?.chatId,
      chatName: channelEndpoint?.chatName,
      chatType: channelEndpoint?.chatType,
      channelType: channelEndpoint?.type,
      channelAccountId: channelEndpoint?.accountId,
      channelTarget: channelEndpoint?.target,
      completionNotice: {
        unread: session.completionNotice.unread,
        unreadCount: session.completionNotice.unreadCount,
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
    await Storage.remove(StoragePath.endpointSession(endpointKey, asSessionID(session.id)))
  }

  export async function withRuntimeInfo(session: Info): Promise<Info & { working?: WorkingInfoType }> {
    session = await SessionRecords.hydrate(session)
    const storedRollback = session.history?.rollback
    const [working, history] = await Promise.all([
      SessionWorking.resolve(session.id),
      storedRollback?.canUnrollback === true
        ? SessionHistory.storedInfo(session.id).catch(() => session.history)
        : session.history,
    ])
    const result = { ...withoutRuntimeInfo(session), history }
    if (!working) return result
    return { ...result, working }
  }

  async function withClientInfo(session: Info): Promise<Info & { working?: WorkingInfoType }> {
    const info = await withRuntimeInfo(session)
    if (info.controlProfile) return info
    return {
      ...info,
      controlProfile: await resolveControlProfile(info.id),
    }
  }

  // Dedup redundant session.updated publishes: a diff limited to time.updated
  // (or a byte-identical payload) is throttled to a heartbeat, while any real
  // field change publishes immediately (issue #319, defense in depth).
  const runtimeState = RuntimeContext.state(() => ({
    lastPublish: new Map<string, { key: string; at: number }>(),
    rollbackInvalidationPending: new Set<string>(),
  }))
  const PUBLISH_DEDUP_THROTTLE_MS = 1000

  async function publishInfo(
    event: typeof SessionEvent.Updated,
    session: Info,
    navEntry?: SessionNavEntry,
    options?: { force?: boolean },
  ) {
    const instanceState = runtimeState()

    const info = await withRuntimeInfo(session)
    const key = publishCompareKey(info)
    const now = Date.now()
    const prev = instanceState.lastPublish.get(session.id)
    if (
      options?.force !== true &&
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
    const remember = () => {
      if (info.time.archived) instanceState.lastPublish.delete(session.id)
      else instanceState.lastPublish.set(session.id, { key, at: now })
    }
    if (Storage.inTransaction()) Storage.afterCommit(remember)
    else remember()
    Bus.publish(event, { info, navEntry })
  }

  export async function create(
    input?: SessionCreationExtensions & {
      scope?: Scope
      parentID?: string
      provenance?: Info["provenance"]
      title?: string
      permission?: PermissionNext.Ruleset
      controlProfile?: Info["controlProfile"]
      agentOverride?: Info["agentOverride"]
      preAuthorizedActions?: string[]
      endpoint?: SessionEndpoint.Info
      id?: string
      interaction?: SessionInteraction.Info
      cortex?: CortexDelegationInfoType
      workflow?: Info["workflow"]
      workspace?: import("./types").Workspace | null
      workspaceID?: string | null
      forkedFrom?: Info["forkedFrom"]
      completionNotice?: {
        silent?: boolean
      }
    },
  ) {
    const parent = input?.parentID ? await SessionManager.getSession(input.parentID) : undefined
    const scope = input?.scope ?? parent?.scope ?? ScopeContext.current.scope
    const workspaceID =
      input?.workspaceID !== undefined
        ? input.workspaceID
        : input?.workspace === undefined && parent?.scope.id === scope.id
          ? parent.workspaceID
          : undefined
    const workspace =
      workspaceID !== undefined
        ? workspaceID === null
          ? null
          : WorkspaceCatalog.projection(await WorkspaceCatalog.get(workspaceID, scope.id))
        : await WorkspaceBinding.adopt(
            input?.workspace !== undefined
              ? input.workspace
              : parent?.scope.id === scope.id
                ? parent.workspace
                : ScopeContext.defaultWorkspace(scope),
            scope.id,
          )
    if (workspace) {
      Workspace.parse(workspace)
      if (workspace.scopeID !== scope.id) throw new Error("Workspace belongs to a different Scope")
    }
    const inheritedInteraction = input?.interaction ?? parent?.interaction
    const controlProfile = input?.parentID ? undefined : input?.controlProfile
    const completionNotice = {
      unread: false,
      unreadCount: 0,
      silent: input?.completionNotice?.silent ?? parent?.completionNotice.silent ?? false,
    }

    const endpoint = input?.endpoint
    const createdAt = Date.now()
    const scopeType = scope.type === "home" ? "home" : "project"
    const category = SessionNav.deriveCategory({
      scopeType,
      endpointKind: endpoint?.kind,
      provenance: input?.provenance,
      parentID: input?.parentID,
      cortex: input?.cortex,
      background: SessionSchemaRegistry.isBackground(input),
    })

    const result: Info = {
      ...SessionSchemaRegistry.creationFields(input),
      id: Identifier.descending("session", input?.id),
      tags: normalizeSessionTags(input?.tags),
      version: Installation.VERSION,
      scope,
      parentID: input?.parentID,
      forkedFrom: input?.forkedFrom,
      provenance: input?.provenance,
      category,
      title: input?.title ?? createDefaultTitle(!!input?.parentID),
      permission: input?.permission,
      controlProfile,
      agentOverride: input?.agentOverride,
      preAuthorizedActions: input?.preAuthorizedActions,
      endpoint,
      interaction: inheritedInteraction,
      cortex: input?.cortex,
      workflow: input?.workflow,
      workspace,
      workspaceID: workspace?.id ?? workspaceID ?? null,
      completionNotice,
      time: {
        created: createdAt,
        updated: createdAt,
      },
    }
    log.info("created", result)

    await Storage.transaction(async () => {
      if (result.parentID && !(await SessionManager.getSession(result.parentID)))
        throw new Storage.NotFoundError({ message: "Parent Session no longer exists" })
      await Storage.write(
        StoragePath.sessionInfo(asScopeID(scope.id), asSessionID(result.id)),
        SessionRecords.serialize(result),
      )
      await Storage.write(StoragePath.sessionIndex(asSessionID(result.id)), toIndex(result))
      await writeEndpointIndex(result)
      await upsertPageIndexEntry(scope.id, toPageIndexEntry(result))
      if (result.parentID) await upsertChildIndexEntry(scope.id, result.parentID, toChildIndexEntry(result))
      const navEntry = await SessionNav.upsertNavEntry(toNavEntry(result))

      await SessionSchemaRegistry.created(result)

      Storage.afterCommit(() => {
        SessionManager.registerRuntime(result.id)
      })
      await Scope.touch(scope.id)

      await publishInfo(SessionEvent.Updated, result, navEntry)
    })
    return withRuntimeInfo(result)
  }

  export async function applyWorkspaceSelection(
    sessionID: string,
    selection?: WorkspaceSelection,
  ): Promise<Info & { working?: WorkingInfoType }> {
    const session = await get(sessionID)
    if (
      !selection ||
      (selection.mode === "current" && (session.workspace || session.workspaceID || !session.scope.local))
    )
      return session
    if (selection.mode === "workspace") {
      SessionManager.assertIdle(sessionID)
      const workspace = await WorkspaceBinding.validate(
        selection.workspaceID,
        session.scope.id,
        selection.workspaceGeneration,
      )
      return updateWorkspace(sessionID, workspace, { requireIdle: true })
    }
    if (selection.mode === "none" || selection.mode === "current") {
      SessionManager.assertIdle(sessionID)
      const workspace = selection.mode === "none" ? null : ScopeContext.defaultWorkspace(session.scope)
      return updateWorkspace(sessionID, workspace, { requireIdle: true })
    }

    if (selection.mode === "create") {
      await SessionWorkspaceRuntime.get().createWorktree({
        sessionID,
        name: selection.name,
        baseRef: selection.baseRef ?? "current",
        baseRevision: selection.baseRevision,
        bind: true,
      })
      return get(sessionID)
    }
    await SessionWorkspaceRuntime.get().enterWorktree({
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
          z.object({
            type: z.literal("through"),
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
      const position = input.position
      const forkPoint =
        position?.type === "before" || position?.type === "through" ? position.messageID : input.messageID
      const includeForkPoint = position?.type === "through"
      // Validate the fork point against the effective (rollback-projected)
      // history before creating the fork, so a stale point from a bounded
      // client window cannot silently fork at the head or create an orphan.
      const msgs = await messages({ sessionID: input.sessionID })
      if (forkPoint && !msgs.some((msg) => msg.info.id === forkPoint)) {
        throw new ForkPointMissingError({
          sessionID: input.sessionID,
          messageID: forkPoint,
          message: "The fork point message is no longer part of the effective session history.",
        })
      }
      const sessionID = Identifier.descending("session")
      const createInput = {
        id: sessionID,
        scope: source.scope as Scope,
        workspace: source.workspace,
        workspaceID: source.workspaceID,
        title: input.title,
        controlProfile: input.controlProfile ?? (await resolveControlProfile(source.id)),
        forkedFrom: {
          sessionID: source.id,
          messageID: forkPoint,
          title: source.title,
        },
      }
      const selected = forkPoint
        ? msgs.slice(0, msgs.findIndex((msg) => msg.info.id === forkPoint) + (includeForkPoint ? 1 : 0))
        : msgs
      const stagingID = await SessionStaging.begin(source.scope.id, [sessionID])
      let session: Info | undefined
      try {
        await SnapshotLifecycle.adopt({
          scopeID: source.scope.id,
          sourceSessionID: source.id,
          targetSessionID: sessionID,
          hashes: selected.flatMap((msg) => msg.parts.flatMap(SnapshotRecords.partRoots)),
        })
        const messageMap = new Map(selected.map((msg) => [msg.info.id, Identifier.ascending("message")]))
        const prepared: MessageV2.WithParts[] = selected.map((msg) => ({
          info: {
            ...msg.info,
            ...(msg.info.role === "assistant" ? { accounting: MessageV2.copyAccounting(msg.info, "inherited") } : {}),
            sessionID,
            id: messageMap.get(msg.info.id)!,
            ...("parentID" in msg.info && typeof msg.info.parentID === "string"
              ? { parentID: messageMap.get(msg.info.parentID) ?? msg.info.parentID }
              : {}),
          },
          parts: [],
        }))
        const jobs = selected.flatMap((msg, messageIndex) =>
          msg.parts.map((part) => ({ part, messageIndex, id: Identifier.ascending("part") })),
        )
        const from = { kind: "session" as const, scopeID: source.scope.id, sessionID: source.id }
        const to = { ...from, sessionID }
        // One part queue bounds all artifact copies; workMap drains started writes before staging cleanup.
        const parts = await workMap(FORK_PREPARE_CONCURRENCY, jobs, async ({ part, messageIndex, id }) => {
          const state = part.type === "tool" && part.state.status === "completed" ? { ...part.state } : undefined
          if (state?.outputArtifact) state.outputArtifact = await RolloutArtifact.copy(from, to, state.outputArtifact)
          if (state?.attachments) {
            const attachments = []
            for (const attachment of state.attachments)
              attachments.push({
                ...attachment,
                ...(attachment.artifact ? { artifact: await RolloutArtifact.copy(from, to, attachment.artifact) } : {}),
              })
            state.attachments = attachments
          }
          const artifact =
            part.type === "attachment" && part.artifact
              ? await RolloutArtifact.copy(from, to, part.artifact)
              : undefined
          return preparePart(
            {
              ...part,
              ...(artifact ? { artifact } : {}),
              ...(state ? { state } : {}),
              id,
              messageID: prepared[messageIndex].info.id,
              sessionID,
            },
            source.scope.id,
          )
        })
        for (const [index, part] of parts.entries()) prepared[jobs[index].messageIndex].parts.push(part)
        session = await Storage.transaction(async () => {
          const created = await create(createInput)
          for (const message of prepared) {
            await updateMessage(message.info)
            for (const part of message.parts) await updatePart(part)
          }
          await SessionStaging.finish(stagingID)
          return created
        })

        session = await applyWorkspaceSelection(session.id, input.workspace)
      } catch (error) {
        if (session) await remove(session.id)
        else await SessionStaging.discard(stagingID)
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

  export async function assertWorkspaceAvailable(sessionID: string) {
    const session = await get(sessionID)
    const { workspace } = session
    if (session.workspaceID) {
      await WorkspaceBinding.validate(session.workspaceID, session.scope.id, workspace?.generation)
      return
    }
    if (workspace) throw new Error("Session has no canonical Workspace reference")
  }

  export async function updateWorkspace(
    sessionID: string,
    workspace: import("./types").Workspace | null,
    options?: { requireIdle?: boolean; preserveActivityAt?: boolean },
  ): Promise<Info> {
    const session = await SessionManager.requireSession(sessionID)
    if (!WorkspaceAccess.owns(sessionID)) SessionManager.assertIdle(sessionID)
    workspace = workspace?.id
      ? await WorkspaceBinding.validate(workspace.id, session.scope.id, workspace.generation)
      : await WorkspaceBinding.adopt(workspace, session.scope.id)
    return WorkspaceAccess.transition(sessionID, workspace, async () => {
      if (workspace && WorkspaceAccess.owns(sessionID)) {
        const { WorkspaceRuntime } = await import("../workspace/runtime")
        await ScopeContext.provide({
          scope: session.scope,
          workspace,
          fn: () => WorkspaceRuntime.ensure(session.scope, workspace!),
        })
      }
      return updateInternal(
        sessionID,
        (draft) => {
          if (options?.requireIdle || !WorkspaceAccess.owns(sessionID)) SessionManager.assertIdle(sessionID)
          if (workspace) {
            Workspace.parse(workspace)
            if (workspace.scopeID !== draft.scope.id) throw new Error("Workspace belongs to a different Scope")
          }
          draft.workspace = workspace
          draft.workspaceID = workspace?.id ?? null
        },
        { ...options, workspaceChange: true },
      )
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

  async function collectDescendantIDs(sessionID: string): Promise<string[]> {
    const ids: string[] = []
    for (const child of await children(sessionID)) {
      ids.push(child.id)
      const sub = await collectDescendantIDs(child.id)
      ids.push(...sub)
    }
    return ids
  }

  export async function transitionControlProfileAndResolve(
    sessionID: string,
    controlProfile: NonNullable<Info["controlProfile"]>,
    editor?: (session: Info) => void,
  ): Promise<Info> {
    const updated = await update(sessionID, (draft) => {
      draft.controlProfile = controlProfile
      editor?.(draft)
    })

    const descendantIDs = await collectDescendantIDs(sessionID)
    const inheritingIDs = [sessionID]
    for (const descID of descendantIDs) {
      const state = await sessionControlProfileState(descID)
      if (state.root.id === sessionID) {
        inheritingIDs.push(descID)
      }
    }

    await PermissionNext.resolveAllForSessions(inheritingIDs)

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
        (await SessionRecords.read(StoragePath.sessionInfo(asScopeID(scope.id), asSessionID(currentID)))) ?? session
      if (info.controlProfile) return { controlProfile: info.controlProfile, root: info }
      if (!info.parentID) return { root: info }
      currentID = info.parentID
    }
  }

  const NON_INTERACTIVE_DEFAULT: ProfileId = "autonomous"

  /** True for root sessions with no human available to answer an approval prompt. */
  function isNonInteractiveSource(session?: object): boolean {
    const endpoint = (session as { endpoint?: { kind?: string } } | undefined)?.endpoint
    if (endpoint?.kind === "channel") return true
    return session ? SessionSchemaRegistry.isBackground(session) : false
  }

  /**
   * Single owner of the source default. A top-level profile that can answer for
   * itself still applies to non-interactive roots, so an operator who set
   * `full_access` or `autonomous` keeps it. `guarded` cannot: an ask raised with
   * nobody attached would pend forever, which is why the non-interactive key does
   * not offer it and why the source default supplies `autonomous` instead.
   */
  export async function defaultControlProfileForSessionSource(
    session?: object,
    topLevelProfile?: string,
  ): Promise<ProfileId> {
    const topLevel = topLevelProfile ? ControlProfileCompiler.normalize(topLevelProfile) : undefined
    if (!isNonInteractiveSource(session)) return topLevel ?? "guarded"
    if (topLevel && topLevel !== "guarded") return topLevel

    const configured = await Config.current()
      .then((cfg) => cfg.nonInteractiveControlProfile)
      .catch(() => undefined)
    return configured ? ControlProfileCompiler.normalize(configured) : NON_INTERACTIVE_DEFAULT
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

    return defaultControlProfileForSessionSource(sessionState?.root, topLevelProfile)
  }

  export async function resolveControlProfile(sessionID: string): Promise<NonNullable<Info["controlProfile"]>> {
    return resolveEffectiveControlProfile({ sessionID })
  }

  export const get = fn(Identifier.schema("session"), async (id) => {
    const session = await SessionManager.requireSession(id)
    const scope = session.scope as Scope
    const read = await SessionRecords.read(StoragePath.sessionInfo(asScopeID(scope.id), asSessionID(id)))
    const info = read as Info
    return withClientInfo(info)
  })

  // Acquire this publication queue before SQL; a transaction must never wait
  // on a queued mutation that needs the same SQL writer.
  const completionNoticeMutations = Storage.state(() => new Map<string, Promise<void>>())

  function serializeCompletionNoticeMutation<T>(id: string, mutation: () => Promise<T>): Promise<T> {
    if (Storage.inTransaction()) return mutation()
    const queue = completionNoticeMutations()
    const previous = queue.get(id) ?? Promise.resolve()
    const current = previous.then(mutation, mutation)
    const settled = current.then(
      () => undefined,
      () => undefined,
    )
    queue.set(id, settled)
    void settled.finally(() => {
      if (queue.get(id) === settled) queue.delete(id)
    })
    return current
  }

  export async function acknowledgeRollback(id: string, rollbackID: string): Promise<RollbackAck> {
    await SessionCompat.requireImported(id)
    return Storage.transaction(async () => {
      const session = await SessionManager.requireSession(id)
      const scope = session.scope as Scope
      const scopeID = asScopeID(scope.id)
      const sessionID = asSessionID(id)

      const currentRollbackID = (await SessionHistory.storedInfo(id))?.rollback?.id
      if (currentRollbackID !== rollbackID) {
        throw new RollbackAckConflictError({
          message: currentRollbackID
            ? "Only the current rollback can be acknowledged."
            : "No active rollback can be acknowledged.",
          rollbackID,
          currentRollbackID,
        })
      }

      let changed = false
      const result = await SessionRecords.update(StoragePath.sessionInfo(scopeID, sessionID), (draft) => {
        if (draft.rollbackAck?.rollbackID === rollbackID) return
        draft.rollbackAck = { rollbackID, acknowledgedAt: Date.now() }
        changed = true
      })
      const rollbackAck = result.rollbackAck
      if (!rollbackAck) {
        throw new RollbackAckConflictError({
          message: "No active rollback can be acknowledged.",
          rollbackID,
        })
      }
      if (changed) await publishInfo(SessionEvent.Updated, result)
      return rollbackAck
    })
  }

  async function acknowledgeCompletionNoticeResult(
    id: string,
    acknowledgedCount: number,
    options?: { repairNavOnNoop?: boolean },
  ) {
    await SessionCompat.requireImported(id)
    return serializeCompletionNoticeMutation(id, () =>
      Storage.transaction(async () => {
        if (!Number.isSafeInteger(acknowledgedCount) || acknowledgedCount < 0) {
          throw new TypeError("acknowledgedCount must be a non-negative safe integer")
        }

        const session = await SessionManager.requireSession(id)
        const scope = session.scope as Scope
        const scopeID = asScopeID(scope.id)
        const sessionID = asSessionID(id)

        let actualAcknowledgedCount = 0
        const result = await SessionRecords.update(StoragePath.sessionInfo(scopeID, sessionID), (draft) => {
          const current = draft.completionNotice.unreadCount ?? (draft.completionNotice.unread ? 1 : 0)
          const next = Math.max(0, current - acknowledgedCount)
          actualAcknowledgedCount = current - next
          draft.completionNotice.unread = next > 0
          draft.completionNotice.unreadCount = next
        })
        if (actualAcknowledgedCount === 0 && !options?.repairNavOnNoop) {
          return { info: await withRuntimeInfo(result), acknowledgedCount: 0 }
        }

        const navEntry = await SessionNav.upsertNavEntry(toNavEntry(result))
        await publishInfo(SessionEvent.Updated, result, navEntry)
        return { info: await withRuntimeInfo(result), acknowledgedCount: actualAcknowledgedCount }
      }),
    )
  }

  export async function acknowledgeCompletionNotice(id: string, acknowledgedCount: number) {
    return (await acknowledgeCompletionNoticeResult(id, acknowledgedCount)).info
  }

  export async function batchAcknowledgeCompletionNotices() {
    const entries = await SessionNav.listUnreadCompletionEntries()
    let acknowledgedCount = 0
    let modifiedSessionCount = 0
    let failedSessionCount = 0
    for (const entry of entries) {
      const capturedCount = entry.completionNotice.unreadCount
      if (capturedCount === 0) continue
      try {
        const result = await acknowledgeCompletionNoticeResult(entry.id, capturedCount, { repairNavOnNoop: true })
        acknowledgedCount += result.acknowledgedCount
        if (result.acknowledgedCount > 0) modifiedSessionCount++
      } catch (error) {
        failedSessionCount++
        log.warn("failed to acknowledge completion notice", { sessionID: entry.id, error })
      }
    }
    return { acknowledgedCount, modifiedSessionCount, failedSessionCount }
  }

  export async function clearCompletionNotice(id: string) {
    return acknowledgeCompletionNotice(id, Number.MAX_SAFE_INTEGER)
  }

  export async function recordCompletionNotice(id: string, options?: { publishEvent?: boolean }) {
    await SessionCompat.requireImported(id)
    return serializeCompletionNoticeMutation(id, () =>
      Storage.transaction(async () => {
        let unreadCount: number | undefined
        const result = await update(id, (draft) => {
          if (draft.time.archived || draft.completionNotice.silent) return
          const current = draft.completionNotice.unreadCount ?? (draft.completionNotice.unread ? 1 : 0)
          const next = Math.min(Number.MAX_SAFE_INTEGER, current + 1)
          draft.completionNotice.unread = true
          draft.completionNotice.unreadCount = next
          if (next !== current) unreadCount = next
        })
        if (unreadCount !== undefined && options?.publishEvent !== false) {
          await Bus.publish(SessionEvent.Completion, { sessionID: id, unreadCount })
        }
        return result
      }),
    )
  }

  async function updateInternal(
    id: string,
    editor: (session: Info) => void,
    options?: { preserveActivityAt?: boolean; forcePublish?: boolean; workspaceChange?: boolean },
  ) {
    await SessionCompat.requireImported(id)
    return Storage.transaction(async () => {
      const session = await SessionManager.requireSession(id)
      const scope = session.scope as Scope
      const scopeID = asScopeID(scope.id)
      const sessionID = asSessionID(id)

      const before = structuredClone(session)
      const result = structuredClone(session)
      editor(result)
      if (
        !options?.workspaceChange &&
        (result.workspaceID !== before.workspaceID ||
          JSON.stringify(result.workspace) !== JSON.stringify(before.workspace))
      )
        throw new Error("Use Session.updateWorkspace to change a Session's Workspace binding")
      if (result.workspace) {
        result.workspace = await WorkspaceBinding.adopt(result.workspace, scope.id)
        result.workspaceID = result.workspace?.id ?? null
      }
      if (!options?.preserveActivityAt) result.time.updated = Date.now()
      await Storage.write(StoragePath.sessionInfo(scopeID, sessionID), SessionRecords.serialize(result))

      await Storage.write(StoragePath.sessionIndex(asSessionID(result.id)), toIndex(result))
      await upsertPageIndexEntry(scope.id, toPageIndexEntry(result))
      if (before.parentID && before.parentID !== result.parentID) {
        await removeChildIndexEntry(scope.id, before.parentID, result.id)
      }
      if (result.parentID) {
        await upsertChildIndexEntry(scope.id, result.parentID, toChildIndexEntry(result))
      }
      // Freeze nav activity while the turn is unfinished, in either sense: an
      // in-flight turn (the runtime still owns it) or one that stopped and is
      // waiting for the user. Ordered writes to a running session's title must
      // not churn the sidebar ordering, and a paused session's activity
      // timestamp is the moment it stopped, not the moment its latch was last
      // re-described.
      const unfinished = SessionManager.isRunning(id) || (!!before.paused && !!result.paused)
      const shouldPreserveActivityAt = options?.preserveActivityAt ?? unfinished
      const navEntry = await SessionNav.upsertNavEntry(toNavEntry(result), {
        preserveActivityAt: shouldPreserveActivityAt,
      })

      const beforeKey = before.endpoint ? SessionEndpoint.toKey(before.endpoint) : undefined
      const afterKey = result.endpoint ? SessionEndpoint.toKey(result.endpoint) : undefined
      if (beforeKey && beforeKey !== afterKey) {
        await removeEndpointIndex(before)
      }
      if (result.endpoint) {
        await writeEndpointIndex(result)
      }

      if (
        (!before.time.archived && result.time.archived) ||
        before.workspace?.path !== result.workspace?.path ||
        before.workspace?.type !== result.workspace?.type
      ) {
        const previous = before
        Storage.afterCommit(() => SessionWorkspaceRuntime.releaseSession(previous))
      }
      await publishInfo(SessionEvent.Updated, result, navEntry, { force: options?.forcePublish })
      return withRuntimeInfo(result)
    })
  }

  export async function update(id: string, editor: (session: Info) => void) {
    return updateInternal(id, editor)
  }

  export async function recordActivity(id: string) {
    return updateInternal(id, () => {}, { preserveActivityAt: false, forcePublish: true })
  }

  export const diff = fn(Identifier.schema("session"), async (sessionID) => {
    const session = await SessionManager.requireSession(sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    const diffs = await Storage.read<SnapshotSchema.FileDiff[]>(
      StoragePath.sessionSummary(scopeID, asSessionID(sessionID)),
    ).catch(() => [])
    return SnapshotSchema.normalizeArray(diffs) ?? []
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

  export const messagePage = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (input) => {
      await flushPartWrites(input.sessionID)
      return SessionHistory.messagePage(input)
    },
  )

  export const rollback = SessionHistory.rollback
  export const unrollback = SessionHistory.unrollback
  export const restoreFiles = SessionHistory.restoreFiles

  export type ListResult = {
    data: Info[]
    total: number
  }

  async function readListInfos(scopeID: string, ids: string[]) {
    const sid = asScopeID(scopeID)
    const keys = ids.map((id) => StoragePath.sessionInfo(sid, asSessionID(id)))
    const sessions = await SessionRecords.readMany(keys)
    for (const [index, id] of ids.entries()) {
      const info = await SessionCompat.pendingInfo(scopeID, id)
      if (info) sessions[index] = info
    }
    return sessions
  }

  export async function list(options?: {
    offset?: number
    limit?: number
    search?: string
    since?: number
    before?: number
    pinned?: boolean
    parentOnly?: boolean
    tag?: string
  }): Promise<ListResult> {
    const scopeID = asScopeID(ScopeContext.current.scope.id)
    const index = await readPageIndex(scopeID)
    let entries = index.entries.filter((e) => !e.archived)

    if (options?.parentOnly !== false) entries = entries.filter((e) => !e.parentID)
    if (options?.tag !== undefined) {
      const tag = normalizeSessionTags([options.tag])[0]
      if (!tag) return { data: [], total: 0 }
      const sessions = await readListInfos(
        scopeID,
        entries.map((entry) => entry.id),
      )
      entries = entries.filter((_, sessionIndex) => sessions[sessionIndex]?.tags?.includes(tag))
    }
    if (options?.pinned) entries = entries.filter((e) => e.pinned > 0)
    if (options?.since) entries = entries.filter((e) => e.updated >= options.since!)
    if (options?.before) entries = entries.filter((e) => e.updated < options.before!)

    // When searching, we must read all matching session infos first because
    // title-based search cannot be applied on the page index alone.
    if (options?.search) {
      const sessions = await readListInfos(
        scopeID,
        entries.map((e) => e.id),
      )
      const term = options.search.toLowerCase()
      const matched = sessions.filter((s): s is Info => s != null && !!s.scope && s.title.toLowerCase().includes(term))
      const total = matched.length
      const offset = options?.offset ?? 0
      const limit = options?.limit ?? total
      const data = await Promise.all(matched.slice(offset, offset + limit).map((s) => withClientInfo(s)))
      return { data, total }
    }

    const total = entries.length
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? total
    const slice = entries.slice(offset, offset + limit)

    if (slice.length === 0) return { data: [], total }

    const sessions = await readListInfos(
      scopeID,
      slice.map((e) => e.id),
    )
    const data = await Promise.all(
      sessions.filter((s): s is Info => s != null && !!s.scope).map((s) => withClientInfo(s)),
    )

    return { data, total }
  }

  export async function* listAll() {
    const scopeID = asScopeID(ScopeContext.current.scope.id)
    const ids = await Storage.scan(StoragePath.sessionsRoot(scopeID))
    const keys = ids.map((id) => StoragePath.sessionInfo(scopeID, asSessionID(id)))
    const sessions = await SessionRecords.readMany(keys)
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
    const sessions = await SessionRecords.readMany(keys)
    const items = await Promise.all(
      sessions
        .filter((session): session is Info => session != null && !!session.scope)
        .map((session) => withClientInfo(session)),
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
    const pending = [sessionID]
    const drained = new Set<string>()
    while (pending.length) {
      const id = pending.pop()!
      if (drained.has(id)) continue
      drained.add(id)
      if (!(await SessionManager.getSession(id))) continue
      await flushPartWrites(id)
      for (const child of await children(id)) pending.push(child.id)
    }
    const removed: Info[] = []
    await Storage.transaction(async () => {
      const visiting = new Set<string>()
      async function removeTree(id: string) {
        if (visiting.has(id)) throw new Error("Session ancestry contains a cycle")
        visiting.add(id)
        const session = await SessionManager.getSession(id)
        if (!session) return
        const scope = session.scope as Scope
        const scopeID = asScopeID(scope.id)
        const sid = asSessionID(id)
        for (const child of await children(id)) await removeTree(child.id)
        await SnapshotLifecycle.scheduleDelete(scope.id, id)
        await removeEndpointIndex(session)
        await MessageV2.removeOrderIndex(scopeID, sid)
        await SessionNav.removeNavEntry(scope.id, id)
        await Storage.removeTree(StoragePath.sessionRoot(scopeID, sid))
        await Storage.remove(StoragePath.sessionIndex(sid))
        await removePageIndexEntry(scope.id, id)
        if (session.parentID) await removeChildIndexEntry(scope.id, session.parentID, id)
        await SessionSearchIndex.removeRecords(scopeID, sid)
        await removeChildIndex(scope.id, id)
        Storage.afterCommit(() => {
          SessionManager.unregisterRuntime(id)
          SessionManager.forgetSession(id)
          SessionMessageCache.disable(id)
        })
        await ScopeContext.provide({ scope, fn: () => Bus.publish(SessionEvent.Deleted, { info: session }) })
        removed.push(session)
      }
      await removeTree(sessionID)
    })
    for (const session of removed) {
      await SessionWorkspaceRuntime.releaseSession(session)
      await SnapshotLifecycle.completeDelete(session.scope.id, session.id)
    }
  })

  export async function updateLastExchange(sessionID: string) {
    await SessionCompat.requireImported(sessionID)
    return Storage.transaction(async () => {
      const session = await SessionManager.requireSession(sessionID)
      const scopeID = asScopeID((session.scope as Scope).id)
      const lastExchange: NonNullable<Info["lastExchange"]> = {}
      const msgs = await SessionHistory.modelMessages({ sessionID })
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
      await SessionRecords.update(infoPath, (draft) => {
        draft.lastExchange = lastExchange
      })
    })
  }

  // A root user message written after a rollback invalidates redo, but that
  // derived state lives in the persisted session projection. Publish the flip
  // once so the frontend stops prefix-hiding the replacement branch.

  async function publishRollbackInvalidation(canonical: MessageV2.Info, history: Info["history"]) {
    const instanceState = runtimeState()

    if (canonical.role !== "user") return
    if ((canonical as MessageV2.User).isRoot === false) return
    const rollback = history?.rollback
    if (!rollback?.canUnrollback) return
    if (canonical.time.created <= rollback.created) return
    if (instanceState.rollbackInvalidationPending.has(canonical.sessionID)) return
    instanceState.rollbackInvalidationPending.add(canonical.sessionID)
    try {
      await update(canonical.sessionID, (draft) => {
        if (draft.history?.rollback?.id !== rollback.id) return
        draft.history.rollback.canUnrollback = false
      })
    } catch (error) {
      log.warn("failed to publish rollback invalidation", { sessionID: canonical.sessionID, error })
    } finally {
      instanceState.rollbackInvalidationPending.delete(canonical.sessionID)
    }
  }

  export const updateMessage = fn(MessageV2.Info, async (msg) => {
    await SessionCompat.requireImported(msg.sessionID)
    return Storage.transaction(async () => {
      const canonical = MessageV2.canonicalMessage(msg)
      const session = await SessionManager.requireSession(msg.sessionID)
      const scopeID = asScopeID((session.scope as Scope).id)
      // Invalidate the search index BEFORE the content write so a crash between
      // the write and the post-write mark can never leave a clean-but-stale
      // record trusted; the post-write mark below refreshes the marker for any
      // scan that races this write (commitRebuild only clears markers older
      // than its scan start).
      await SessionSearchIndex.markDirty(scopeID, asSessionID(canonical.sessionID))
      await MessageV2.writeInfo({ scopeID, info: canonical })
      SessionMessageCache.upsertMessage(canonical.sessionID, canonical)
      // Flip the rollback projection before publishing the replacement root: the
      // frontend prefix-cut hides everything after the cut while canUnrollback is
      // true, so the new branch must never arrive ahead of its invalidation.
      await publishRollbackInvalidation(canonical, session.history)
      Bus.publish(MessageV2.Event.Updated, {
        info: canonical,
      })
      await SessionSearchIndex.markDirty(scopeID, asSessionID(canonical.sessionID))
      return canonical
    })
  })

  export async function updateAssistantContextUsage(input: {
    sessionID: string
    messageID: string
    contextUsage: NonNullable<MessageV2.Assistant["contextUsage"]>
  }) {
    await SessionCompat.requireImported(input.sessionID)
    return Storage.transaction(async () => {
      const session = await SessionManager.requireSession(input.sessionID)
      const scopeID = asScopeID((session.scope as Scope).id)
      const result = await Storage.update<MessageV2.Info>(
        StoragePath.messageInfo(scopeID, asSessionID(input.sessionID), asMessageID(input.messageID)),
        (draft) => {
          if (draft.role !== "assistant") throw new Error("Context Usage can only be attached to assistant messages")
          draft.contextUsage = input.contextUsage
        },
      )
      const canonical = MessageV2.canonicalMessage(result)
      SessionMessageCache.upsertMessage(canonical.sessionID, canonical)
      Bus.publish(MessageV2.Event.Updated, {
        info: canonical,
      })
      return canonical as MessageV2.Assistant
    })
  }

  export const mergeMessageMetadata = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
      metadata: z.record(z.string(), z.any()),
    }),
    async (input) => {
      await SessionCompat.requireImported(input.sessionID)
      return Storage.transaction(async () => {
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
        SessionMessageCache.upsertMessage(result.sessionID, result)
        Bus.publish(MessageV2.Event.Updated, {
          info: result,
        })
        return result
      })
    },
  )

  export const removeMessage = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      await flushPartWrites(input.sessionID)
      await SessionCompat.requireImported(input.sessionID)
      return Storage.transaction(async () => {
        const session = await SessionManager.requireSession(input.sessionID)
        const scopeID = asScopeID((session.scope as Scope).id)
        // See updateMessage: invalidate before the content write, refresh after.
        await SessionSearchIndex.markDirty(scopeID, asSessionID(input.sessionID))
        await MessageV2.removeInfo({
          scopeID,
          sessionID: asSessionID(input.sessionID),
          messageID: asMessageID(input.messageID),
        })
        // Structural change: drop the cache and let the next read repopulate.
        SessionMessageCache.invalidate(input.sessionID)
        Bus.publish(MessageV2.Event.Removed, {
          sessionID: input.sessionID,
          messageID: input.messageID,
        })
        await SessionSearchIndex.markDirty(scopeID, asSessionID(input.sessionID))
        return input.messageID
      })
    },
  )

  export const removePart = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
      partID: Identifier.schema("part"),
    }),
    async (input) => {
      await flushPartWrites(input.sessionID)
      await SessionCompat.requireImported(input.sessionID)
      return Storage.transaction(async () => {
        const session = await SessionManager.requireSession(input.sessionID)
        const scopeID = asScopeID((session.scope as Scope).id)
        // See updateMessage: invalidate before the content write, refresh after.
        await SessionSearchIndex.markDirty(scopeID, asSessionID(input.sessionID))
        await Storage.remove(
          StoragePath.messagePart(
            scopeID,
            asSessionID(input.sessionID),
            asMessageID(input.messageID),
            asPartID(input.partID),
          ),
        )
        SessionMessageCache.invalidate(input.sessionID)
        Bus.publish(MessageV2.Event.PartRemoved, {
          sessionID: input.sessionID,
          messageID: input.messageID,
          partID: input.partID,
        })
        await SessionSearchIndex.markDirty(scopeID, asSessionID(input.sessionID))
        return input.partID
      })
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
  // Part files are the highest-frequency writes and are never hand-edited, so
  // they persist as compact JSON (no pretty-print) to cut serialization and disk
  // bytes on the streaming path.
  const partWriteBuffer = Storage.state(() => {
    const handle = { store: Storage.current().store, artifactDirectory: Storage.current().artifactDirectory }
    return new PartWriteBuffer<MessageV2.Part, string[]>((key, value) =>
      Storage.provide(handle, () =>
        Storage.transaction(async (tx) => {
          await assertPartOwner(tx, key)
          await tx.write(key, value)
        }),
      ),
    )
  })

  async function assertPartOwner(tx: StoreTransaction, key: string[]) {
    await tx.read(["sessions", key[1], key[2], "info"])
    await tx.read(["sessions", key[1], key[2], "messages", key[4], "info"])
    await tx.assertNotDeleted(key)
  }

  /**
   * Flush all buffered streaming part writes to disk and await them. Called at
   * turn finalization so the persisted parts reflect everything streamed — most
   * importantly when a turn is interrupted mid-stream and the terminal part
   * write that normally flushes never fired (issue #327).
   */
  export function flushPartWrites(sessionID?: string) {
    if (!sessionID) return partWriteBuffer().flushAll()
    return partWriteBuffer().flushWhere((part) => part.sessionID === sessionID)
  }

  type UpdatePartInternalInput =
    | MessageV2.Part
    | { part: MessageV2.TextPart; delta: string }
    | { part: MessageV2.ReasoningPart; delta: string }

  export async function preparePart(input: MessageV2.Part, ownerScopeID?: string): Promise<MessageV2.Part> {
    let part = input
    const scopeID = asScopeID(ownerScopeID ?? (await SessionManager.resolveScopeID(part.sessionID)))
    try {
      const owner = { kind: "session" as const, scopeID, sessionID: part.sessionID }
      if (part.type === "attachment") part = await RolloutAttachment.capture(owner, part)
      if (part.type === "tool" && part.state.status === "completed" && part.state.attachments) {
        const attachments = []
        for (const attachment of part.state.attachments)
          attachments.push(await RolloutAttachment.capture(owner, attachment))
        part = { ...part, state: { ...part.state, attachments } }
      }
      if (part.type === "tool" && part.state.status === "completed" && !part.state.outputArtifact) {
        const outputArtifact = await RolloutArtifact.writeText(
          { kind: "session", scopeID, sessionID: part.sessionID },
          part.state.output,
        )
        part = { ...part, state: { ...part.state, outputArtifact } }
      } else if (part.type === "tool" && part.state.status === "completed" && part.state.outputArtifact) {
        const owner = { kind: "session" as const, scopeID, sessionID: part.sessionID }
        const ref = part.state.outputArtifact
        const outputArtifact = await record(async () => {
          const stored = await RolloutArtifact.get(owner, ref.id)
          if (stored.status !== "complete" || stored.sha256 !== ref.sha256 || stored.bytes !== ref.bytes) {
            throw new Error("Tool output artifact does not match its committed evidence")
          }
          return stored
        })
        part = { ...part, state: { ...part.state, outputArtifact } }
      }
    } catch (error) {
      if (RolloutRecordingError.isInstance(error)) {
        const causal = RolloutContext.current()
        const message = await MessageV2.get({ sessionID: part.sessionID, messageID: part.messageID }).catch(
          () => undefined,
        )
        const rootID =
          causal?.owner.kind === "session" && causal.owner.sessionID === part.sessionID
            ? causal.runID
            : (message?.info.rootID ?? (message?.info.role === "user" ? message.info.id : message?.info.parentID))
        if (rootID) SessionManager.signalAbort(part.sessionID, { rootID })
      }
      throw error
    }
    return part
  }

  async function updatePartInternal(input: UpdatePartInternalInput) {
    let part = "delta" in input ? input.part : input
    const delta = "delta" in input ? input.delta : undefined
    // Streaming hot path (issue #350 H1): resolve the scopeID from the permanent
    // sessionID -> scopeID cache instead of loading full session info on every
    // delta. A session's scope is immutable, so this is safe; on a cold cache it
    // reads only the small session-index record.
    const scopeID = asScopeID(await SessionManager.resolveScopeID(part.sessionID))
    part = await preparePart(part)
    if (delta === undefined) part = MessageV2.canonicalPart(part)
    const path = StoragePath.messagePart(
      scopeID,
      asSessionID(part.sessionID),
      asMessageID(part.messageID),
      asPartID(part.id),
    )
    const transactional = Storage.inTransaction()
    if (delta !== undefined && !transactional) {
      // The delta is exactly what the streaming producer appended to the part's
      // text, so the buffer can price this update without re-serializing the
      // whole accumulated part on every token.
      partWriteBuffer().defer(part.id, path, part, delta)
    } else {
      const write = (key: string[], value: MessageV2.Part) =>
        Storage.transaction(async (tx) => {
          await assertPartOwner(tx, key)
          await Storage.write(key, value)
          if (value.type === "text" || value.type === "tool" || value.type === "attachment")
            await SessionSearchIndex.markDirty(scopeID, asSessionID(value.sessionID))
          SessionMessageCache.upsertPart(value.sessionID, value)
          await Bus.publish(MessageV2.Event.PartUpdated, { part: value, delta })
        })
      if (transactional) {
        partWriteBuffer().assertDrained(part.id)
        await write(path, part)
      } else await partWriteBuffer().writeNow(part.id, path, part, write)
    }
    if (part.type === "tool") {
      // Tool parts are published as unsequenced streaming events. Keep a
      // durable breadcrumb so missing frontend cards can be correlated with
      // backend settlement (issue #509).
      const tool = part as MessageV2.ToolPart
      log.info("tool.part.publish", {
        sessionID: tool.sessionID,
        messageID: tool.messageID,
        partID: tool.id,
        callID: tool.callID,
        tool: tool.tool,
        status: tool.state.status,
        durable: delta === undefined,
      })
    }
    if (delta !== undefined && !transactional) await Bus.publish(MessageV2.Event.PartUpdated, { part, delta })
    return part
  }

  export const updatePart = fn(UpdatePartInput, updatePartInternal)

  export function updatePartDelta(part: MessageV2.TextPart | MessageV2.ReasoningPart, delta: string) {
    // The union member is selected by the concrete part type at the call site;
    // both text and reasoning parts take the identical internal delta path.
    return updatePartInternal({ part, delta } as UpdatePartInternalInput)
  }

  export const getUsage = fn(
    z.object({
      model: z.custom<Provider.Model>(),
      usage: z.custom<LanguageModelUsage>(),
      metadata: z.custom<ProviderMetadata>().optional(),
    }),
    (input) => {
      const usageCacheHitTokens = usageNumber(input.usage, ["prompt_cache_hit_tokens", "promptCacheHitTokens"])
      const usageCacheMissTokens = usageNumber(input.usage, ["prompt_cache_miss_tokens", "promptCacheMissTokens"])
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
      const cachedInputTokens = input.usage.cachedInputTokens ?? usageCacheHitTokens ?? providerCacheHitTokens ?? 0
      const excludesCachedTokens = !!(input.metadata?.["anthropic"] || input.metadata?.["bedrock"])
      const safe = (value: number) => {
        if (!Number.isFinite(value)) return 0
        return value
      }
      const adjustedInputTokens =
        usageCacheMissTokens ??
        providerCacheMissTokens ??
        (excludesCachedTokens ? (input.usage.inputTokens ?? 0) : (input.usage.inputTokens ?? 0) - cachedInputTokens)

      // @ai-sdk/google 2.0.49 reports candidatesTokenCount separately from thoughtsTokenCount;
      // OpenAI 2.0.111 already includes reasoning in output_tokens/completion_tokens.
      const separateReasoning =
        (input.model.api.npm === "@ai-sdk/google" || input.model.api.npm === "@ai-sdk/google-vertex") &&
        input.model.providerID !== "google-vertex-anthropic"

      const tokens = {
        input: safe(adjustedInputTokens),
        output: safe((input.usage.outputTokens ?? 0) + (separateReasoning ? (input.usage.reasoningTokens ?? 0) : 0)),
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
            .toNumber(),
        ),
        tokens,
      }
    },
  )

  function usageNumber(usage: LanguageModelUsage, keys: string[]): number | undefined {
    const record = usage as unknown as Record<string, unknown>
    for (const key of keys) {
      const value = record[key]
      if (typeof value === "number" && Number.isFinite(value)) return value
    }
    return undefined
  }

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

  function endpointLockKey(endpoint: SessionEndpoint.Info): string {
    const hash = new Bun.CryptoHasher("sha256").update(SessionEndpoint.toKey(endpoint)).digest("hex")
    return `session:endpoint:${hash}`
  }

  function assertEndpointScope(session: Info, scope: Scope): void {
    if (session.scope.id === scope.id) return
    throw new EndpointScopeMismatchError({
      sessionID: session.id,
      existingScopeID: session.scope.id,
      requestedScopeID: scope.id,
    })
  }

  export async function findForEndpoint(endpoint: SessionEndpoint.Info, options: { scope: Scope }) {
    const existing = await SessionManager.getSession(endpoint)
    if (existing) assertEndpointScope(existing, options.scope)
    return existing
  }

  export async function getOrCreateForEndpoint(
    endpoint: SessionEndpoint.Info,
    options: {
      scope: Scope
      interaction?: SessionInteraction.Info
      title?: string
      agentOverride?: Info["agentOverride"]
      controlProfile?: Info["controlProfile"]
      boundSessionID?: string
    },
  ) {
    const lock = await Lock.write(endpointLockKey(endpoint))
    try {
      let bound: Info | undefined
      if (options.boundSessionID) {
        bound = await SessionManager.requireSession(options.boundSessionID)
        assertEndpointScope(bound, options.scope)
        if (!bound.endpoint || SessionEndpoint.toKey(bound.endpoint) !== SessionEndpoint.toKey(endpoint)) {
          throw new Storage.NotFoundError({
            message: `Session ${options.boundSessionID} is not bound to the requested endpoint`,
          })
        }
        if (bound.time.archived) throw new EndpointSessionArchivedError({ sessionID: bound.id })
      }
      const existing = bound ?? (await SessionManager.getSession(endpoint))
      if (existing) {
        assertEndpointScope(existing, options.scope)
        const existingChatName = existing.endpoint?.kind === "channel" ? existing.endpoint.channel?.chatName : undefined
        const newChatName = endpoint.kind === "channel" ? endpoint.channel.chatName : undefined
        const isPlatformID = (name: string | undefined): boolean => !!name && /^(ou_|on_|oc_|user_)/.test(name)
        const chatNameChanged =
          (newChatName != null && existingChatName !== newChatName) ||
          (isPlatformID(existingChatName) && newChatName == null)
        const interactionChanged =
          options.interaction !== undefined &&
          JSON.stringify(existing.interaction) !== JSON.stringify(options.interaction)
        if (chatNameChanged || interactionChanged) {
          return await ScopeContext.provide({
            scope: options.scope,
            fn: () =>
              update(existing.id, (draft) => {
                if (draft.endpoint?.kind === "channel") {
                  draft.endpoint.channel.chatName = newChatName
                }
                if (interactionChanged) draft.interaction = options.interaction
              }),
          })
        }
        return existing
      }
      return await ScopeContext.provide({
        scope: options.scope,
        fn: () =>
          create({
            scope: options.scope,
            endpoint,
            interaction: options.interaction,
            title: options.title,
            agentOverride: options.agentOverride,
            controlProfile: options.controlProfile,
          }),
      })
    } finally {
      lock[Symbol.dispose]()
    }
  }

  export async function archiveForEndpoint(
    endpoint: SessionEndpoint.Info,
    options: { scope: Scope; requireIdle?: boolean },
  ) {
    using _ = await Lock.write(endpointLockKey(endpoint))
    const session = await SessionManager.getSession(endpoint)

    if (!session) return
    assertEndpointScope(session, options.scope)
    if (options.requireIdle) SessionManager.assertIdle(session.id)
    await ScopeContext.provide({
      scope: options.scope,
      fn: () =>
        update(session.id, (draft) => {
          draft.time.archived = Date.now()
        }),
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

export function registerSessionResolver() {
  MessageV2.installSessionResolver((sessionID) => SessionManager.requireSession(sessionID))
}
