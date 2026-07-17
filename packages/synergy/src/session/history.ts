import path from "path"
import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Identifier } from "@/id/id"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { fn } from "@/util/fn"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { MessageV2 } from "./message-v2"
import { SessionMessageCache } from "./message-cache"

const log = Log.create({ service: "session.history" })
import { SessionManager } from "./manager"
import { Snapshot } from "./snapshot"
import type { Info } from "./types"

export namespace SessionHistory {
  const { asScopeID, asSessionID, asHistoryID, asMessageID } = Identifier

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

  export const FileRestoreResult = z
    .object({
      restoredFiles: z.array(z.string()),
      patchPartIDs: z.array(Identifier.schema("part")),
      rollbackID: Identifier.schema("history").optional(),
      messageID: Identifier.schema("message").optional(),
      partID: Identifier.schema("part").optional(),
    })
    .meta({ ref: "SessionFileRestoreResult" })
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

  function getCutMessageID(event: { cutMessageID?: string; droppedMessageIDs: string[] }): string | undefined {
    return event.cutMessageID ?? event.droppedMessageIDs[0]
  }

  export const rollback = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      numTurns: z.number().int().min(1).optional(),
      cutMessageID: z.string().optional(),
    }),
    async (input) => {
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
    },
  )

  export const unrollback = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      rollbackID: Identifier.schema("history").optional(),
    }),
    async (input) => {
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
    },
  )

  export const restoreFiles = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      rollbackID: Identifier.schema("history").optional(),
      messageID: Identifier.schema("message").optional(),
      partID: Identifier.schema("part").optional(),
      files: z.array(z.string()).optional(),
    }),
    async (input): Promise<FileRestoreResult> => {
      SessionManager.assertIdle(input.sessionID)
      const [raw, events] = await Promise.all([
        rawMessages({ sessionID: input.sessionID }),
        readEvents(input.sessionID),
      ])
      const active = activeRollbacks(events)
      const rollbackEvent = input.rollbackID
        ? active.find((event) => event.id === input.rollbackID)
        : input.messageID || input.partID
          ? undefined
          : latest(events)
      if ((input.rollbackID || (!input.messageID && !input.partID)) && !rollbackEvent) {
        throw new FileRestoreMissingPatchDataError({
          message: "No patch data is available for the requested file restore.",
        })
      }
      const patches = collectPatches(raw, {
        rollback: rollbackEvent,
        messageID: input.messageID,
        partID: input.partID,
        files: input.files,
      })

      if (patches.length === 0) {
        throw new FileRestoreMissingPatchDataError({
          message: "No patch data is available for the requested file restore.",
        })
      }

      await Snapshot.revert(
        patches.map((patch) => ({ hash: patch.hash, files: patch.files })),
        input.sessionID,
      )

      return {
        restoredFiles: unique(patches.flatMap((patch) => patch.files)),
        patchPartIDs: patches.map((patch) => patch.id),
        rollbackID: rollbackEvent?.id ?? input.rollbackID,
        messageID: input.messageID,
        partID: input.partID,
      }
    },
  )

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
    const useCache = !Flag.SYNERGY_DISABLE_MESSAGE_CACHE
    let cached = useCache ? SessionMessageCache.get(input.sessionID) : undefined
    if (cached && Flag.SYNERGY_VERIFY_MESSAGE_CACHE) {
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

  async function loadModelMessages(input: { sessionID: string; onLoadParts?: (messageID: string) => void }) {
    const [infos, events] = await Promise.all([readMessageInfo(input.sessionID), readEvents(input.sessionID)])
    const loadedParts = new Map<string, MessageV2.Part[]>()
    const loadParts = async (messageID: string) => {
      const cachedParts = loadedParts.get(messageID)
      if (cachedParts) return cachedParts
      input.onLoadParts?.(messageID)
      const parts = await MessageV2.parts({ sessionID: input.sessionID, messageID })
      loadedParts.set(messageID, parts)
      return parts
    }
    const canonicalInfos = await deriveRollbackSemantics(infos, events, loadParts)
    const effective = applyEventsToInfo(canonicalInfos, events)
    if (effective.length === 0) return []

    let latestSummaryIndex = -1
    let boundaryUserID: string | undefined
    for (let index = effective.length - 1; index >= 0; index--) {
      const info = effective[index]
      if (info.role !== "assistant" || !info.summary || !info.finish) continue
      latestSummaryIndex = index
      boundaryUserID = info.parentID
      break
    }

    let selected = effective
    if (latestSummaryIndex >= 0 && boundaryUserID) {
      const boundaryIndex = effective.findIndex(
        (info, index) => index < latestSummaryIndex && info.role === "user" && info.id === boundaryUserID,
      )
      if (boundaryIndex >= 0) {
        const boundaryParts = await loadParts(boundaryUserID)
        if (boundaryParts.some((part) => part.type === "compaction")) {
          const earlierSummaries = effective.slice(boundaryIndex + 1, latestSummaryIndex).flatMap((info) => {
            if (info.role !== "assistant" || info.parentID !== boundaryUserID || !info.summary || !info.finish)
              return []
            return [{ ...info, includeInContext: false }]
          })
          selected = [effective[boundaryIndex], ...earlierSummaries, ...effective.slice(latestSummaryIndex)]
        }
      }
    }

    const messages = await Promise.all(
      selected.map(async (info) => ({
        info,
        parts: await loadParts(info.id),
      })),
    )
    return MessageV2.deriveSemantics(messages)
  }

  export async function messages(input: { sessionID: string; limit?: number; raw?: boolean }) {
    const raw = await rawMessages({ sessionID: input.sessionID })
    const result = input.raw ? raw : applyEvents(raw, await readEvents(input.sessionID))
    return sliceWithReferencedRoots(result, input.limit)
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
    const legacy = new Set(
      messages.flatMap((message) => (message.role === "user" && message.isRoot === undefined ? [message.id] : [])),
    )
    if (legacy.size === 0) return messages
    const withParts = await Promise.all(
      messages.map(async (info) => ({
        info,
        parts: legacy.has(info.id) ? await loadParts(info.id) : [],
      })),
    )
    return MessageV2.deriveSemantics(withParts).map((message) => message.info)
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
    SessionManager.bumpHistoryRevision(event.sessionID)
    const session = await SessionManager.requireSession(event.sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    await Storage.remove(StoragePath.sessionSummaryCursor(scopeID, asSessionID(event.sessionID)))
    await Storage.write(
      StoragePath.sessionHistoryEvent(scopeID, asSessionID(event.sessionID), asHistoryID(event.id)),
      event,
    )
    await Storage.remove(StoragePath.sessionSummaryCursor(scopeID, asSessionID(event.sessionID)))
    SessionManager.bumpHistoryRevision(event.sessionID)
    SessionMessageCache.invalidate(event.sessionID)
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
    const scopeID = asScopeID((session.scope as Scope).id)
    const ids = await Storage.scan(StoragePath.sessionMessagesRoot(scopeID, asSessionID(sessionID)))
    const messages = await Storage.readMany<MessageV2.Info>(
      ids.map((id) => StoragePath.messageInfo(scopeID, asSessionID(sessionID), asMessageID(id))),
    )
    return messages.filter((msg): msg is MessageV2.Info => !!msg).sort(MessageV2.compareStorageOrder)
  }

  function canUnrollbackInfo(messages: MessageV2.Info[], event: RollbackEvent) {
    // Only invalidate when a new root user message was created after the rollback.
    // Non-root user messages and assistant messages do not invalidate.
    return !messages.some((msg) => {
      if (msg.role !== "user") return false
      // Only explicit non-root injections are exempt; a new root (or an
      // un-derived legacy user message) invalidates redo.
      if ((msg as MessageV2.User).isRoot === false) return false
      return msg.time.created > event.time.created
    })
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
    const files = input.files ? new Set(input.files.map(normalizeFile)) : undefined
    const result: Array<MessageV2.PatchPart & { files: string[] }> = []

    for (const msg of messages) {
      if (messageIDs.size > 0 && !messageIDs.has(msg.info.id)) continue
      for (const part of msg.parts) {
        if (part.type !== "patch") continue
        if (input.partID && part.id !== input.partID) continue
        const selectedFiles = files ? part.files.filter((file) => files.has(normalizeFile(file))) : part.files
        if (selectedFiles.length === 0) continue
        result.push({ ...part, files: selectedFiles })
      }
    }
    return result
  }

  function normalizeFile(file: string) {
    return path.isAbsolute(file) ? path.normalize(file) : path.resolve(ScopeContext.current.directory, file)
  }

  function unique(values: string[]) {
    return Array.from(new Set(values))
  }
}
