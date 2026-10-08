import path from "path"
import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Identifier } from "../id/id"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { fn } from "../util/fn"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"
import { SessionMessageCache } from "./message-cache"
import { applyModelWorkingSetProjection, modelWorkingSetProjection } from "./model-working-set"
import { SessionManager } from "./manager"
import { SessionHistoryDisplay } from "./history-display"
import { SessionHistorySearch } from "./history-search"
import { UpgradeWork } from "../storage/upgrade-work"
import { withStorageQueueOptions } from "../storage/queue"
import { Snapshot } from "./snapshot"
import { SnapshotRestore } from "./snapshot-restore"
import { SnapshotRanges } from "./snapshot-ranges"
import { SessionFileRestore } from "./file-restore"
import type { Info } from "./types"
import { prepareSessionMigrations } from "../migration"

const log = Log.create({ service: "session.history" })
const PAGE_HYDRATION_CONCURRENCY = 16

export namespace SessionHistory {
  export const TimelinePage = SessionHistoryDisplay.TimelinePage
  export const PartPage = SessionHistoryDisplay.PartPage
  export const PartContent = SessionHistoryDisplay.PartContent
  export const DisplayConflict = SessionHistoryDisplay.Conflict
  export const summarizePart = SessionHistoryDisplay.summarizePart
  export const summarizeMessage = SessionHistoryDisplay.summarizeMessage
  export const MessageDetails = SessionHistoryDisplay.MessageDetails

  export async function prepareDisplay(sessionID: string, progress?: (current: number, total: number) => void) {
    const session = await SessionManager.requireSession(sessionID)
    await prepareSessionMigrations({ scopeID: session.scope.id, sessionID: session.id })
    return prepareDisplayOwner({ scopeID: session.scope.id, sessionID: session.id }, progress)
  }

  async function prepareSessionDisplay(session: Info, input?: { cursor?: string; limit?: number; messageID?: string }) {
    const readOnlySnapshot = Storage.inTransaction() && !Storage.inWriteTransaction()
    if (!readOnlySnapshot) await prepareSessionMigrations({ scopeID: session.scope.id, sessionID: session.id })
    const scopeID = asScopeID(session.scope.id)
    const sessionID = asSessionID(session.id)
    const target = input?.messageID
      ? await Storage.read<MessageV2.Info>(
          StoragePath.messageInfo(scopeID, sessionID, Identifier.asMessageID(input.messageID)),
        ).catch((error) => {
          if (error instanceof Storage.NotFoundError) return undefined
          throw error
        })
      : undefined
    const before = target
      ? `${MessageV2.messageOrderMarker(target)}\uffff`
      : input?.cursor
        ? SessionHistoryDisplay.cursorOrder(input.cursor)
        : undefined
    const limit = Math.min(256, Math.max(100, (input?.limit ?? 50) + 100))
    const infos: MessageV2.Info[] = []
    for await (const info of MessageV2.readNewestInfos({ scopeID, sessionID, before, limit })) infos.push(info)
    await SessionHistoryDisplay.prepareWindow(scopeID, sessionID, infos.toReversed())
  }

  export async function prepareDisplayOwner(
    owner: { scopeID: string; sessionID: string },
    progress?: (current: number, total: number) => void,
  ) {
    const scopeID = asScopeID(owner.scopeID)
    const sessionID = asSessionID(owner.sessionID)
    await SessionHistoryDisplay.prepare(
      scopeID,
      sessionID,
      async () => {
        const infos = await MessageV2.readInfoList({ scopeID, sessionID })
        return deriveInfoSemantics(infos, (messageID) => MessageV2.parts({ scopeID, sessionID, messageID }))
      },
      progress,
    )
  }

  export async function timelinePage(input: {
    sessionID: string
    cursor?: string
    limit?: number
    messageID?: string
  }) {
    const session = await SessionManager.requireSession(input.sessionID)
    await prepareSessionDisplay(session, input)
    return SessionHistoryDisplay.timelinePage(input, await displayVisibility(session), session.scope.id)
  }

  export async function latestRootID(sessionID: string) {
    const session = await SessionManager.requireSession(sessionID)
    await prepareSessionDisplay(session)
    return SessionHistoryDisplay.latestRoot(session.scope.id, sessionID, await displayVisibility(session))
  }

  async function displayVisibility(session: Info) {
    const sessionID = session.id
    const [events, lastRoot] = await Promise.all([
      readSessionEvents(session),
      SessionHistoryDisplay.latestRootCreated(session.scope.id, sessionID),
    ])
    const hidden = new Set<string>()
    let cut: string | undefined
    for (const event of activeRollbacks(events)) {
      const id = getCutMessageID(event)
      const header =
        id && canUnrollbackAt(lastRoot, event)
          ? await SessionHistoryDisplay.header(session.scope.id, sessionID, id)
          : undefined
      if (header) cut = cut ? (cut < header.order ? cut : header.order) : header.order
      else for (const messageID of event.droppedMessageIDs) hidden.add(messageID)
    }
    return { hidden, cut }
  }

  export async function requireDisplayMessage(session: Info, messageID: string) {
    const sessionID = session.id
    await prepareSessionDisplay(session, { messageID })
    const [header, visibility] = await Promise.all([
      SessionHistoryDisplay.header(session.scope.id, sessionID, messageID),
      displayVisibility(session),
    ])
    if (header && !visibility.hidden.has(messageID) && (!visibility.cut || header.order < visibility.cut)) return header
    throw new Storage.NotFoundError({ message: "Message is outside the effective Session history" })
  }
  export async function partPage(input: Parameters<typeof SessionHistoryDisplay.partPage>[0]) {
    const session = await SessionManager.requireSession(input.sessionID)
    await requireDisplayMessage(session, input.messageID)
    return SessionHistoryDisplay.partPage(input, session.scope.id)
  }
  export async function partContent(input: Parameters<typeof SessionHistoryDisplay.partContent>[0]) {
    const session = await SessionManager.requireSession(input.sessionID)
    await requireDisplayMessage(session, input.messageID)
    return SessionHistoryDisplay.partContent(input, session.scope.id)
  }
  export async function messageDetails(input: Parameters<typeof SessionHistoryDisplay.messageDetails>[0]) {
    const session = await SessionManager.requireSession(input.sessionID)
    await requireDisplayMessage(session, input.messageID)
    return SessionHistoryDisplay.messageDetails(input, session.scope.id)
  }

  export const SearchPage = z
    .object({
      items: z
        .object({
          sessionID: Identifier.schema("session"),
          messageID: Identifier.schema("message"),
          partID: Identifier.schema("part"),
          version: z.string(),
          category: z.enum(["text", "reasoning", "tool"]),
          role: z.enum(["user", "assistant"]),
          offset: z.number(),
          text: z.string(),
        })
        .array(),
      nextCursor: z.string().nullable(),
      preparing: z.boolean(),
      prepared: z.number(),
      scanned: z.number(),
      indexed: z.boolean(),
    })
    .meta({ ref: "SessionHistorySearchPage" })

  export async function search(input: {
    sessionID: string
    query: string
    reasoning?: boolean
    tools?: boolean
    cursor?: string
    limit?: number
    signal?: AbortSignal
  }): Promise<z.infer<typeof SearchPage>> {
    const session = await SessionManager.requireSession(input.sessionID)
    await prepareSessionDisplay(session)
    input.signal?.throwIfAborted()
    const release = UpgradeWork.priority(input.sessionID)
    const preparation = await SessionHistorySearch.prepareBatch(session.scope.id, input.sessionID).finally(release)
    if (!preparation.ready) SessionHistorySearch.requestBackground(session.scope.id, input.sessionID)
    const fingerprint = new Bun.CryptoHasher("sha256")
      .update(
        JSON.stringify([
          session.scope.id,
          input.sessionID,
          input.query,
          Boolean(input.reasoning),
          Boolean(input.tools),
        ]),
      )
      .digest("hex")
    let cursor: string | undefined
    if (input.cursor) {
      try {
        const value = z
          .object({ cursor: z.string(), fingerprint: z.literal(fingerprint) })
          .parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString()))
        cursor = value.cursor
      } catch {
        throw new DisplayConflict({ message: "Search cursor belongs to another query" })
      }
    }
    const page = await Storage.snapshot((tx) =>
      tx.searchTextProjection({
        scopeID: session.scope.id,
        sessionID: input.sessionID,
        query: input.query,
        cursor,
        limit: input.limit,
        categories: [
          "text",
          ...(input.reasoning ? ["reasoning" as const] : []),
          ...(input.tools ? ["tool" as const] : []),
        ],
      }),
    )
    const ids = [...new Set(page.items.map((item) => item.key[4]!))]
    const infos = await Storage.readMany<MessageV2.Info>(
      ids.map((id) =>
        StoragePath.messageInfo(asScopeID(session.scope.id), asSessionID(input.sessionID), Identifier.asMessageID(id)),
      ),
    )
    await SessionHistoryDisplay.prepareWindow(
      session.scope.id,
      input.sessionID,
      infos.filter((info): info is MessageV2.Info => Boolean(info)),
    )
    const [headers, visibility] = await Promise.all([
      Storage.readMany<SessionHistoryDisplay.MessageSummary>(
        ids.map((id) => StoragePath.sessionDisplayMessage(session.scope.id, input.sessionID, id)),
      ),
      displayVisibility(session),
    ])
    const headerMap = new Map(ids.map((id, index) => [id, headers[index]]))
    const items = page.items.flatMap((item) => {
      const header = headerMap.get(item.key[4]!)
      if (
        !header ||
        header.info.visible === false ||
        visibility.hidden.has(header.info.id) ||
        (visibility.cut && header.order >= visibility.cut)
      )
        return []
      return [
        {
          sessionID: input.sessionID,
          messageID: header.info.id,
          partID: item.key[6]!,
          version: item.version,
          category: item.category,
          role: header.info.role,
          offset: item.offset,
          text: item.text,
        },
      ]
    })
    return {
      items,
      nextCursor:
        page.nextCursor && Buffer.from(JSON.stringify({ cursor: page.nextCursor, fingerprint })).toString("base64url"),
      preparing: !preparation.ready,
      prepared: preparation.prepared,
      scanned: page.scanned,
      indexed: page.indexed,
    }
  }
  export async function text(input: {
    sessionID: string
    messageID?: string
    rootID?: string
    role?: "user" | "assistant"
    latest?: boolean
    reasoning?: boolean
    tools?: boolean
  }) {
    await prepareDisplay(input.sessionID)
    return withStorageQueueOptions({ priority: "background" }, () =>
      Storage.snapshot(async () => {
        const headers: SessionHistoryDisplay.MessageSummary[] = []
        let cursor: string | undefined
        do {
          const page = await timelinePage({
            sessionID: input.sessionID,
            messageID: input.messageID,
            cursor,
            limit: 100,
          })
          headers.unshift(...page.items)
          cursor = input.messageID ? undefined : (page.nextCursor ?? undefined)
        } while (cursor)
        let selected = headers.filter(
          (header) =>
            (!input.messageID || header.info.id === input.messageID) &&
            (!input.rootID || header.info.rootID === input.rootID || header.info.id === input.rootID) &&
            (!input.role || header.info.role === input.role) &&
            header.info.visible !== false,
        )
        if (input.latest) selected = selected.slice(-1)
        const session = await SessionManager.requireSession(input.sessionID)
        const chunks: string[] = []
        for (const header of selected) {
          const parts: MessageV2.Part[] = []
          for await (const record of Storage.records<MessageV2.Part>({
            kind: "part",
            scopeID: session.scope.id,
            sessionID: input.sessionID,
            messageID: header.info.id,
          }))
            parts.push(record.value)
          const texts = parts.filter(
            (part): part is MessageV2.TextPart => part.type === "text" && !MessageV2.isSystemPart(part),
          )
          for (const part of texts) chunks.push(part.text)
          if (input.reasoning || (header.info.role === "assistant" && !parts.some((part) => part.type === "text")))
            for (const part of parts) if (part.type === "reasoning") chunks.push(part.text)
          if (input.tools)
            for (const part of parts) {
              if (part.type !== "tool") continue
              chunks.push(JSON.stringify(part.state.input))
              if (part.state.status === "completed") chunks.push(part.state.output)
              if (part.state.status === "error") chunks.push(part.state.error)
            }
        }
        return chunks.join("\n\n")
      }),
    )
  }
  const { asScopeID, asSessionID, asHistoryID } = Identifier

  export const RollbackEvent = z
    .object({
      id: Identifier.schema("history"),
      sessionID: Identifier.schema("session"),
      type: z.literal("rollback"),
      time: z.object({
        created: z.number(),
      }),
      numTurns: z.number(),
      droppedMessageIDs: z.array(Identifier.schema("message")),
      droppedUserMessageIDs: z.array(Identifier.schema("message")),
      cutMessageID: z.string().optional(),
      files: z.array(z.string()),
      patchPartIDs: z.array(Identifier.schema("part")),
    })
    .meta({ ref: "SessionRollbackEvent" })
  export type RollbackEvent = z.infer<typeof RollbackEvent>

  export const UnrollbackEvent = z
    .object({
      id: Identifier.schema("history"),
      sessionID: Identifier.schema("session"),
      type: z.literal("unrollback"),
      time: z.object({
        created: z.number(),
      }),
      rollbackID: Identifier.schema("history"),
    })
    .meta({ ref: "SessionUnrollbackEvent" })
  export type UnrollbackEvent = z.infer<typeof UnrollbackEvent>

  export const Event = z.discriminatedUnion("type", [RollbackEvent, UnrollbackEvent]).meta({
    ref: "SessionHistoryEvent",
  })
  export type Event = z.infer<typeof Event>

  export const RollbackSummary = z
    .object({
      id: Identifier.schema("history"),
      numTurns: z.number(),
      created: z.number(),
      messageID: Identifier.schema("message").optional(),
      droppedMessageIDs: z.array(Identifier.schema("message")),
      droppedUserMessageIDs: z.array(Identifier.schema("message")),
      cutMessageID: z.string().optional(),
      files: z.array(z.string()),
      patchPartIDs: z.array(Identifier.schema("part")),
      canUnrollback: z.boolean(),
    })
    .meta({ ref: "SessionRollbackSummary" })
  export type RollbackSummary = z.infer<typeof RollbackSummary>

  export const FileRestoreResult = SessionFileRestore.Result
  export const FileRestorePreview = SessionFileRestore.Preview
  export type FileRestoreResult = z.infer<typeof FileRestoreResult>

  export const UnrollbackConflictError = NamedError.create(
    "SessionUnrollbackConflictError",
    z.object({
      message: z.string(),
      rollbackID: Identifier.schema("history").optional(),
    }),
  )

  export const FileRestoreMissingPatchDataError = NamedError.create(
    "SessionFileRestoreMissingPatchDataError",
    z.object({
      message: z.string(),
    }),
  )

  export const MessagePageCursor = z.object({
    v: z.literal(1),
    a: z.string().min(1),
    d: z.literal("before"),
  })
  export type MessagePageCursor = z.infer<typeof MessagePageCursor>

  export const MessagePage = z
    .object({
      items: MessageV2.WithParts.array(),
      referencedRoots: MessageV2.WithParts.array(),
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
      total: z.number().int().nonnegative(),
    })
    .meta({ ref: "SessionMessagePage" })
  export type MessagePage = z.infer<typeof MessagePage>

  export const MessagePageCursorInvalidError = NamedError.create(
    "SessionMessagePageCursorInvalidError",
    z.object({ message: z.string() }),
  )

  export const MessagePageCursorStaleError = NamedError.create(
    "SessionMessagePageCursorStaleError",
    z.object({ message: z.string(), anchorID: z.string() }),
  )

  function encodeMessagePageCursor(cursor: MessagePageCursor) {
    return Buffer.from(JSON.stringify(cursor)).toString("base64url")
  }

  function decodeMessagePageCursor(cursor: string) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
      const parsed = MessagePageCursor.safeParse(decoded)
      if (parsed.success) return parsed.data
    } catch {}
    throw new MessagePageCursorInvalidError({ message: "Invalid session message cursor" })
  }

  function getCutMessageID(event: { cutMessageID?: string; droppedMessageIDs: string[] }): string | undefined {
    return event.cutMessageID ?? event.droppedMessageIDs[0]
  }

  export const rollback = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      numTurns: z.number().int().min(1).optional(),
      cutMessageID: z.string().optional(),
    }),
    async (input) =>
      Storage.transaction(async () => {
        if ((input.numTurns == null) === (input.cutMessageID == null)) {
          throw new Error("Provide exactly one of numTurns or cutMessageID")
        }
        SessionManager.assertIdle(input.sessionID)
        const [raw, events] = await Promise.all([
          rawMessages({ sessionID: input.sessionID }),
          readEvents(input.sessionID),
        ])
        const effective = applyEvents(raw, events)

        let cutMessageID: string | undefined
        let dropped: MessageV2.WithParts[] = []

        if (input.cutMessageID) {
          // cutMessageID mode: drop everything from cutMessageID onward
          cutMessageID = input.cutMessageID
          const cutIndex = effective.findIndex((msg) => msg.info.id === cutMessageID)
          if (cutIndex >= 0) {
            dropped = effective.slice(cutIndex)
          }
        } else {
          // numTurns mode (must be defined due to .refine)
          const numTurns = input.numTurns!
          const turnStarts = effective.map((msg, index) => ({ msg, index })).filter(({ msg }) => isRollbackUser(msg))
          if (turnStarts.length === 0) return latestInfo(input.sessionID, raw, events)
          const selected = turnStarts.slice(-numTurns)
          const cutoff = selected[0].index
          dropped = effective.slice(cutoff)
          if (dropped.length === 0) return latestInfo(input.sessionID, raw, events)
          cutMessageID = selected[0].msg.info.id
        }

        const selectedTurns = dropped.filter(isRollbackUser).length

        const event: RollbackEvent = {
          id: Identifier.ascending("history"),
          sessionID: input.sessionID,
          type: "rollback",
          time: {
            created: Date.now(),
          },
          numTurns: selectedTurns,
          cutMessageID,
          droppedMessageIDs: dropped.map((msg) => msg.info.id),
          droppedUserMessageIDs: dropped.filter(isRollbackUser).map((msg) => msg.info.id),
          ...summarizePatches(dropped),
        }
        await writeEvent(event)

        const nextEvents = [...events, event]
        await updateSessionHistory(input.sessionID, info(input.sessionID, raw, nextEvents))
        return event
      }),
  )

  export const unrollback = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      rollbackID: Identifier.schema("history").optional(),
    }),
    async (input) =>
      Storage.transaction(async () => {
        SessionManager.assertIdle(input.sessionID)
        const [raw, events] = await Promise.all([
          rawMessages({ sessionID: input.sessionID }),
          readEvents(input.sessionID),
        ])
        const target = input.rollbackID
          ? activeRollbacks(events).find((event) => event.id === input.rollbackID)
          : latest(events)
        if (!target) return latestInfo(input.sessionID, raw, events)

        const latestRollback = latest(events)
        if (!latestRollback || latestRollback.id !== target.id) {
          throw new UnrollbackConflictError({
            message: "Only the latest rollback can be restored.",
            rollbackID: target.id,
          })
        }

        if (!canUnrollback(raw, target)) {
          throw new UnrollbackConflictError({
            message: "Cannot redo this rollback after new session messages have been added.",
            rollbackID: target.id,
          })
        }

        const event: UnrollbackEvent = {
          id: Identifier.ascending("history"),
          sessionID: input.sessionID,
          type: "unrollback",
          time: {
            created: Date.now(),
          },
          rollbackID: target.id,
        }
        await writeEvent(event)

        const nextEvents = [...events, event]
        await updateSessionHistory(input.sessionID, info(input.sessionID, raw, nextEvents))
        return event
      }),
  )

  export const FileDiffInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message").optional(),
    workspaceID: z.string(),
    generation: z.number().int().positive(),
    file: z.string().min(1),
  })
  export const fileDiff = fn(FileDiffInput, async (input) => {
    return fileDiffWithSignal(input)
  })
  async function fileRange(input: z.infer<typeof FileDiffInput>) {
    await requireRestoreSession(input.sessionID)
    const messages = await SessionHistory.rawMessages({ sessionID: input.sessionID })
    const selected = input.messageID
      ? messages.filter((message) => message.info.id === input.messageID || message.info.rootID === input.messageID)
      : messages
    const range = SnapshotRanges.net(SnapshotRanges.fromMessages(selected)).find(
      (range) => range.workspace?.id === input.workspaceID && range.workspace.generation === input.generation,
    )
    if (!range?.from || !range.to)
      throw new SnapshotRestore.Invalid({ message: "Historical file versions are unavailable" })
    if (range.omissions?.some((item) => item.file === input.file))
      throw new SnapshotRestore.Invalid({ message: "This file was not fully captured" })
    return range as typeof range & { from: string; to: string }
  }
  export async function fileDiffWithSignal(input: z.infer<typeof FileDiffInput>, signal?: AbortSignal) {
    const range = await fileRange(FileDiffInput.parse(input))
    const diff = await Snapshot.fileDiff(
      range.from,
      range.to,
      input.file,
      input.sessionID,
      AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
    )
    if (!diff) throw new SnapshotRestore.Invalid({ message: "This file has no recorded difference" })
    return { ...diff, workspace: range.workspace }
  }
  export async function fileVersions(input: z.infer<typeof FileDiffInput>, signal?: AbortSignal) {
    const range = await fileRange(FileDiffInput.parse(input))
    return Snapshot.fileVersions(
      range.from,
      range.to,
      input.file,
      input.sessionID,
      AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
    )
  }

  const RestoreFilesInput = z.object({
    sessionID: Identifier.schema("session"),
    rollbackID: Identifier.schema("history").optional(),
    messageID: Identifier.schema("message").optional(),
    partID: Identifier.schema("part").optional(),
    files: z.array(z.string()).max(10_000).optional(),
    selectedFiles: z
      .array(z.object({ workspaceID: z.string(), generation: z.number().int().positive(), file: z.string() }))
      .max(10_000)
      .optional(),
    previewID: z.string().uuid().optional(),
  })
  export const restoreFiles = fn(RestoreFilesInput, (input) => restoreFilesWithSignal(input))
  export const previewFiles = fn(RestoreFilesInput.omit({ previewID: true }), (input) => previewFilesWithSignal(input))

  async function restoreSelection(input: z.infer<typeof RestoreFilesInput>) {
    const [raw, events] = await Promise.all([rawMessages({ sessionID: input.sessionID }), readEvents(input.sessionID)])
    const rollback = input.rollbackID
      ? activeRollbacks(events).find((event) => event.id === input.rollbackID)
      : undefined
    if (input.rollbackID && !rollback)
      throw new FileRestoreMissingPatchDataError({ message: "The selected rollback is unavailable" })
    const selected = raw.filter((message) =>
      rollback
        ? rollback.droppedMessageIDs.includes(message.info.id)
        : input.messageID
          ? message.info.id === input.messageID || message.info.rootID === input.messageID
          : true,
    )
    const ranges = SnapshotRanges.net(
      SnapshotRanges.fromMessages(
        selected.map((message) =>
          input.partID ? { ...message, parts: message.parts.filter((part) => part.id === input.partID) } : message,
        ),
      ),
    )
    const patches: Snapshot.Patch[] = []
    for (const range of ranges) {
      if (!range.from || !range.to || !range.workspace) continue
      const files = await Snapshot.changedPaths(range.from, range.to, input.sessionID)
      const source = range.workspace
      const chosen = files.filter(
        (file) =>
          !range.omissions?.some((item) => item.file === file) &&
          (!input.selectedFiles ||
            input.selectedFiles.some(
              (item) => item.workspaceID === source.id && item.generation === source.generation && item.file === file,
            )) &&
          (!input.files || input.files.includes(file) || input.files.includes(path.join(source.root, file))),
      )
      if (chosen.length)
        patches.push({
          hash: range.from,
          workspace: source,
          files: chosen.map((file) => (source.pathKind === "workspace" ? file : path.join(source.root, file))),
        })
    }
    if (!patches.length && !ranges.some((range) => range.checkpointID) && !input.selectedFiles) {
      const legacy = collectPatches(raw, {
        rollback,
        messageID: input.messageID,
        partID: input.partID,
        files: input.files,
      }).filter((part) => !part.checkpoint)
      patches.push(...legacy)
    }
    if (!patches.length)
      throw new FileRestoreMissingPatchDataError({
        message: "No complete snapshot pair is available for the selected files",
      })
    return {
      patches,
      metadata: {
        patchPartIDs: selected.flatMap((message) =>
          message.parts.filter((part) => part.type === "patch").map((part) => part.id),
        ),
        rollbackID: input.rollbackID,
        messageID: input.messageID,
        partID: input.partID,
      },
    }
  }

  async function requireRestoreSession(sessionID: string) {
    const session = await SessionManager.requireSession(sessionID)
    if (session.scope.id !== ScopeContext.current.scope.id)
      throw new Storage.NotFoundError({ message: "Session not found in this Scope" })
  }

  export async function previewFilesWithSignal(input: z.infer<typeof RestoreFilesInput>, signal?: AbortSignal) {
    await requireRestoreSession(input.sessionID)
    return SessionManager.run(
      input.sessionID,
      async (lease) => {
        const abort = signal ? AbortSignal.any([signal, lease.signal]) : lease.signal
        const selection = await restoreSelection(input)
        return SessionFileRestore.prepare({ sessionID: input.sessionID, ...selection, signal: abort })
      },
      { workspace: "history" },
    )
  }

  export async function restoreFilesWithSignal(
    input: z.infer<typeof RestoreFilesInput>,
    signal?: AbortSignal,
  ): Promise<FileRestoreResult> {
    await requireRestoreSession(input.sessionID)
    if (input.previewID) return SessionFileRestore.apply(input.sessionID, input.previewID, signal)
    throw new SnapshotRestore.Invalid({
      message: "Preview file restoration and confirm its version before applying it",
    })
  }

  async function loadRawFromDisk(sessionID: string) {
    const result = [] as MessageV2.WithParts[]
    for await (const msg of MessageV2.stream({ sessionID })) result.push(msg)
    result.reverse()
    return result
  }

  export async function rawMessages(input: { sessionID: string; limit?: number }) {
    const raw = await loadRawFromDisk(input.sessionID)
    const derived = MessageV2.deriveSemantics(raw)
    return sliceWithReferencedRoots(derived, input.limit)
  }

  export async function modelMessages(input: { sessionID: string; onLoadParts?: (messageID: string) => void }) {
    const policy = (await Config.current()).execution?.messageCache
    const useCache = policy?.enabled !== false
    let cached = useCache ? SessionMessageCache.get(input.sessionID) : undefined
    if (cached && policy?.verify) {
      const disk = await loadModelMessages(input)
      if (JSON.stringify(disk) !== JSON.stringify(cached)) {
        log.error("session model message cache diverged from disk; falling back", { sessionID: input.sessionID })
        SessionMessageCache.invalidate(input.sessionID)
        cached = undefined
      }
    }
    if (cached) return MessageV2.deriveSemantics(cached)

    const messages = await loadModelMessages(input)
    if (useCache) SessionMessageCache.set(input.sessionID, messages)
    return messages
  }
  export async function detachedModelMessages(input: {
    sessionID: string
    onLoadParts?: (messageID: string) => void
    signal?: AbortSignal
  }) {
    return loadModelMessages(input)
  }

  async function loadModelMessages(input: {
    sessionID: string
    onLoadParts?: (messageID: string) => void
    signal?: AbortSignal
  }) {
    input.signal?.throwIfAborted()
    const [infos, events] = await Promise.all([readMessageInfo(input.sessionID), readEvents(input.sessionID)])
    input.signal?.throwIfAborted()
    const loadedParts = new Map<string, MessageV2.Part[]>()
    const loadParts = async (messageID: string) => {
      input.signal?.throwIfAborted()
      const cachedParts = loadedParts.get(messageID)
      if (cachedParts) return cachedParts
      input.onLoadParts?.(messageID)
      const parts = await MessageV2.parts({ sessionID: input.sessionID, messageID })
      input.signal?.throwIfAborted()
      loadedParts.set(messageID, parts)
      return parts
    }
    input.signal?.throwIfAborted()
    const canonicalInfos = await deriveRollbackSemantics(infos, events, loadParts)
    const effective = applyEventsToInfo(canonicalInfos, events)
    if (effective.length === 0) return []

    let selected = effective
    const projection = modelWorkingSetProjection(effective)
    if (projection) {
      const boundaryParts = await loadParts(projection.boundaryUserID)
      if (boundaryParts.some((part) => part.type === "compaction")) {
        selected = applyModelWorkingSetProjection(
          effective,
          projection,
          (info) => info,
          (info) => ({ ...info, includeInContext: false }),
        )
      }
    }

    input.signal?.throwIfAborted()
    const messages = await mapWithConcurrency(selected, PAGE_HYDRATION_CONCURRENCY, async (info) => ({
      info,
      parts: await loadParts(info.id),
    }))
    input.signal?.throwIfAborted()
    return MessageV2.deriveSemantics(messages)
  }

  export async function messages(input: { sessionID: string; limit?: number; raw?: boolean }) {
    const raw = await rawMessages({ sessionID: input.sessionID })
    const result = input.raw ? raw : applyEvents(raw, await readEvents(input.sessionID))
    return sliceWithReferencedRoots(result, input.limit)
  }

  export async function messagePage(input: {
    sessionID: string
    cursor?: string
    limit?: number
  }): Promise<MessagePage> {
    const session = await SessionManager.requireSession(input.sessionID)
    const scopeID = session.scope.id
    const [infos, events] = await Promise.all([readMessageInfo(input.sessionID), readEvents(input.sessionID)])
    const loadedParts = new Map<string, MessageV2.Part[]>()
    const loadParts = async (messageID: string) => {
      const cached = loadedParts.get(messageID)
      if (cached) return cached
      const parts = await MessageV2.parts({ scopeID, sessionID: input.sessionID, messageID }).catch((error) => {
        log.warn("skipping unreadable message parts", { sessionID: input.sessionID, messageID, error: String(error) })
        return [] as MessageV2.Part[]
      })
      loadedParts.set(messageID, parts)
      return parts
    }
    const canonicalInfos = await deriveInfoSemantics(infos, loadParts)
    const messages = applyEventsToInfo(canonicalInfos, events)
    const total = messages.length
    let end = total

    if (input.cursor) {
      const cursor = decodeMessagePageCursor(input.cursor)
      end = messages.findIndex((message) => message.id === cursor.a)
      if (end === -1) {
        throw new MessagePageCursorStaleError({
          message: "Session message cursor no longer exists in effective history",
          anchorID: cursor.a,
        })
      }
    }

    const limit = input.limit ?? 200
    const start = Math.max(0, end - limit)
    const itemInfos = messages.slice(start, end)
    const included = new Set(itemInfos.map((message) => message.id))
    const rootIDs = new Set(
      itemInfos
        .map((message) => message.rootID)
        .filter((rootID): rootID is string => !!rootID && !included.has(rootID)),
    )
    const referencedRootInfos = rootIDs.size ? messages.filter((message) => rootIDs.has(message.id)) : []
    const selectedIDs = new Set([...included, ...referencedRootInfos.map((message) => message.id)])
    const selected = messages.filter((message) => selectedIDs.has(message.id))
    const hydrated = await mapWithConcurrency(selected, PAGE_HYDRATION_CONCURRENCY, async (info) => ({
      info,
      parts: await loadParts(info.id),
    }))
    const byID = new Map(MessageV2.deriveSemantics(hydrated).map((message) => [message.info.id, message]))
    const items = itemInfos.flatMap((info) => {
      const message = byID.get(info.id)
      return message ? [message] : []
    })
    const referencedRoots = referencedRootInfos.flatMap((info) => {
      const message = byID.get(info.id)
      return message ? [message] : []
    })
    const hasMore = start > 0
    const oldest = itemInfos[0]

    return {
      items,
      referencedRoots,
      nextCursor: hasMore && oldest ? encodeMessagePageCursor({ v: 1, a: oldest.id, d: "before" }) : null,
      hasMore,
      total,
    }
  }

  function sliceWithReferencedRoots(messages: MessageV2.WithParts[], limit: number | undefined) {
    if (!limit) return messages
    const window = messages.slice(-limit)
    if (window.length === messages.length) return window

    const included = new Set(window.map((msg) => msg.info.id))
    const missingRootIDs = new Set<string>()
    for (const msg of window) {
      const rootID = msg.info.rootID
      if (!rootID || included.has(rootID)) continue
      missingRootIDs.add(rootID)
    }
    if (missingRootIDs.size === 0) return window

    return messages.filter((msg) => included.has(msg.info.id) || missingRootIDs.has(msg.info.id))
  }

  export async function readEvents(sessionID: string) {
    const session = await SessionManager.requireSession(sessionID)
    return readSessionEvents(session)
  }

  async function readSessionEvents(session: Info) {
    const sessionID = session.id
    const scopeID = asScopeID((session.scope as Scope).id)
    const ids = await Storage.scan(StoragePath.sessionHistoryRoot(scopeID, asSessionID(sessionID)))
    const events = await Storage.readMany<Event>(
      ids.map((id) => StoragePath.sessionHistoryEvent(scopeID, asSessionID(sessionID), asHistoryID(id))),
    )
    return events.filter((event): event is Event => !!event).sort((a, b) => a.id.localeCompare(b.id))
  }

  export function applyEvents(messages: MessageV2.WithParts[], events: Event[]) {
    const rollbacks = activeRollbacks(events)
    if (rollbacks.length === 0) return messages

    const cutIndexes: number[] = []
    const hidden = new Set<string>()
    for (const event of rollbacks) {
      const cut = getCutMessageID(event)
      if (cut && canUnrollback(messages, event)) {
        const cutIndex = messages.findIndex((message) => message.info.id === cut)
        if (cutIndex >= 0) {
          cutIndexes.push(cutIndex)
          continue
        }
      }
      for (const id of event.droppedMessageIDs) hidden.add(id)
    }

    return messages.filter((msg, index) => {
      if (cutIndexes.some((cutIndex) => index >= cutIndex)) return false
      return !hidden.has(msg.info.id)
    })
  }

  async function deriveRollbackSemantics(
    messages: MessageV2.Info[],
    events: Event[],
    loadParts: (messageID: string) => Promise<MessageV2.Part[]>,
  ) {
    if (activeRollbacks(events).length === 0) return messages
    return deriveInfoSemantics(messages, loadParts)
  }

  async function deriveInfoSemantics(
    messages: MessageV2.Info[],
    loadParts: (messageID: string) => Promise<MessageV2.Part[]>,
  ) {
    const legacy = new Set(
      messages.flatMap((message) => {
        if (message.role !== "user") return []
        if (message.isRoot !== undefined && message.rootID !== undefined) return []
        return [message.id]
      }),
    )
    const needsDerivation = legacy.size > 0 || messages.some((message) => message.rootID === undefined)
    if (!needsDerivation) return messages
    const withParts = await mapWithConcurrency(messages, PAGE_HYDRATION_CONCURRENCY, async (info) => ({
      info,
      parts: legacy.has(info.id) ? await loadParts(info.id) : [],
    }))
    return MessageV2.deriveSemantics(withParts).map((message) => message.info)
  }

  async function mapWithConcurrency<T, U>(items: T[], concurrency: number, fn: (item: T) => Promise<U>) {
    const result = new Array<U>(items.length)
    let next = 0
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        result[index] = await fn(items[index])
      }
    })
    await Promise.all(workers)
    return result
  }

  function applyEventsToInfo(messages: MessageV2.Info[], events: Event[]) {
    const rollbacks = activeRollbacks(events)
    if (rollbacks.length === 0) return messages

    const cutIndexes: number[] = []
    const hidden = new Set<string>()
    for (const event of rollbacks) {
      const cut = getCutMessageID(event)
      if (cut && canUnrollbackInfo(messages, event)) {
        const cutIndex = messages.findIndex((message) => message.id === cut)
        if (cutIndex >= 0) {
          cutIndexes.push(cutIndex)
          continue
        }
      }
      for (const id of event.droppedMessageIDs) hidden.add(id)
    }

    return messages.filter((message, index) => {
      if (cutIndexes.some((cutIndex) => index >= cutIndex)) return false
      return !hidden.has(message.id)
    })
  }

  export function info(sessionID: string, raw: MessageV2.WithParts[], events: Event[]): Info["history"] | undefined {
    const rollback = latest(events)
    if (!rollback) return undefined
    return infoFromMessageInfo(
      raw.map((msg) => msg.info),
      events,
    )
  }

  export function infoFromMessageInfo(messages: MessageV2.Info[], events: Event[]): Info["history"] | undefined {
    const rollback = latest(events)
    if (!rollback) return undefined
    return {
      rollback: {
        id: rollback.id,
        numTurns: rollback.numTurns,
        created: rollback.time.created,
        messageID: rollback.droppedUserMessageIDs[0],
        droppedMessageIDs: rollback.droppedMessageIDs,
        droppedUserMessageIDs: rollback.droppedUserMessageIDs,
        cutMessageID: rollback.cutMessageID,
        files: rollback.files,
        patchPartIDs: rollback.patchPartIDs,
        canUnrollback: canUnrollbackInfo(messages, rollback),
      },
    }
  }

  export async function storedInfo(sessionID: string): Promise<Info["history"] | undefined> {
    const [messages, events] = await Promise.all([readMessageInfo(sessionID), readEvents(sessionID)])
    return infoFromMessageInfo(messages, events)
  }

  async function latestInfo(sessionID: string, raw: MessageV2.WithParts[], events: Event[]) {
    await updateSessionHistory(sessionID, info(sessionID, raw, events))
    return info(sessionID, raw, events)
  }

  async function writeEvent(event: Event) {
    const { SessionSummary } = await import("./summary")
    const session = await SessionManager.requireSession(event.sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    await Storage.write(
      StoragePath.sessionHistoryEvent(scopeID, asSessionID(event.sessionID), asHistoryID(event.id)),
      event,
    )
    await SessionSummary.invalidateDerivedState(event.sessionID, scopeID)
    Storage.afterCommit(() => {
      SessionManager.bumpHistoryRevision(event.sessionID)
      SessionMessageCache.invalidate(event.sessionID)
    })
  }

  async function updateSessionHistory(sessionID: string, history: Info["history"] | undefined) {
    const { Session } = await import(".")
    await Session.update(sessionID, (draft) => {
      draft.history = history
    })
  }

  // A rollback "turn start" is a root user message: /undo steps by whole tasks.
  // Messages are canonicalized in rawMessages, so isRoot is always populated.
  function isRollbackUser(msg: MessageV2.WithParts) {
    return msg.info.role === "user" && (msg.info as MessageV2.User).isRoot === true
  }

  function activeRollbacks(events: Event[]) {
    const result = new Map<string, RollbackEvent>()
    for (const event of events) {
      if (event.type === "rollback") result.set(event.id, event)
      else result.delete(event.rollbackID)
    }
    return Array.from(result.values()).sort((a, b) => a.id.localeCompare(b.id))
  }

  function latest(events: Event[]) {
    return activeRollbacks(events).at(-1)
  }

  function canUnrollback(messages: MessageV2.WithParts[], event: RollbackEvent) {
    return canUnrollbackInfo(
      messages.map((msg) => msg.info),
      event,
    )
  }

  export function messageInfos(sessionID: string) {
    return readMessageInfo(sessionID)
  }

  async function readMessageInfo(sessionID: string) {
    const session = await SessionManager.requireSession(sessionID)
    return MessageV2.readInfoList({
      scopeID: asScopeID((session.scope as Scope).id),
      sessionID: asSessionID(sessionID),
    })
  }

  function canUnrollbackInfo(messages: MessageV2.Info[], event: RollbackEvent) {
    // Only invalidate when a new root user message was created after the rollback.
    // Non-root user messages and assistant messages do not invalidate.
    return !messages.some((msg) => {
      if (msg.role !== "user") return false
      // Only explicit non-root injections are exempt; a new root (or an
      // un-derived legacy user message) invalidates redo.
      if ((msg as MessageV2.User).isRoot === false) return false
      return !canUnrollbackAt(msg.time.created, event)
    })
  }

  function canUnrollbackAt(lastRootCreated: number, event: RollbackEvent) {
    return lastRootCreated <= event.time.created
  }

  function summarizePatches(messages: MessageV2.WithParts[]) {
    const patchParts = messages.flatMap((msg) =>
      msg.parts.filter((part): part is MessageV2.PatchPart => part.type === "patch"),
    )
    return {
      files: unique(patchParts.flatMap((part) => part.files)),
      patchPartIDs: patchParts.map((part) => part.id),
    }
  }

  function collectPatches(
    messages: MessageV2.WithParts[],
    input: {
      rollback?: RollbackEvent
      messageID?: string
      partID?: string
      files?: string[]
    },
  ) {
    const messageIDs = new Set(input.rollback?.droppedMessageIDs ?? (input.messageID ? [input.messageID] : []))
    const files = input.files ? new Set(input.files) : undefined
    const result: Array<MessageV2.PatchPart & { files: string[] }> = []

    for (const msg of messages) {
      if (messageIDs.size > 0 && !messageIDs.has(msg.info.id)) continue
      for (const part of msg.parts) {
        if (part.type !== "patch") continue
        if (input.partID && part.id !== input.partID) continue
        if (part.operation && part.operation.status !== "complete")
          throw new SnapshotRestore.Invalid({
            message: "File change evidence is incomplete; this operation cannot be restored",
          })
        const root = part.workspace?.root ?? (msg.info.role === "assistant" ? msg.info.path?.cwd : undefined)
        const selectedFiles = files
          ? part.files.filter((file) => files.has(file) || (root && files.has(path.relative(root, file))))
          : part.files
        if (selectedFiles.length === 0) continue
        result.push({ ...part, files: selectedFiles })
      }
    }
    return result
  }

  function unique(values: string[]) {
    return Array.from(new Set(values))
  }
}
