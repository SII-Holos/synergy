import path from "path"
import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Identifier } from "@/id/id"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { fn } from "@/util/fn"
import { MessageV2 } from "./message-v2"
import { SessionManager } from "./manager"
import { Snapshot } from "./snapshot"
import type { Info } from "./types"

export namespace SessionHistory {
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

  export const rollback = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      numTurns: z.number().int().min(1),
    }),
    async (input) => {
      SessionManager.assertIdle(input.sessionID)
      const [raw, events] = await Promise.all([
        rawMessages({ sessionID: input.sessionID }),
        readEvents(input.sessionID),
      ])
      const effective = applyEvents(raw, events)
      const turnStarts = effective.map((msg, index) => ({ msg, index })).filter(({ msg }) => isRollbackUser(msg))

      if (turnStarts.length === 0) return latestInfo(input.sessionID, raw, events)

      const selected = turnStarts.slice(-input.numTurns)
      const cutoff = selected[0].index
      const dropped = effective.slice(cutoff)
      if (dropped.length === 0) return latestInfo(input.sessionID, raw, events)

      const event: RollbackEvent = {
        id: Identifier.ascending("history"),
        sessionID: input.sessionID,
        type: "rollback",
        time: {
          created: Date.now(),
        },
        numTurns: selected.length,
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

  export async function rawMessages(input: { sessionID: string; limit?: number }) {
    const result = [] as MessageV2.WithParts[]
    for await (const msg of MessageV2.stream({ sessionID: input.sessionID })) result.push(msg)
    result.reverse()
    return input.limit ? result.slice(-input.limit) : result
  }

  export async function messages(input: { sessionID: string; limit?: number; raw?: boolean }) {
    const raw = await rawMessages({ sessionID: input.sessionID })
    const result = input.raw ? raw : applyEvents(raw, await readEvents(input.sessionID))
    return input.limit ? result.slice(-input.limit) : result
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
    const hidden = new Set(activeRollbacks(events).flatMap((event) => event.droppedMessageIDs))
    if (hidden.size === 0) return messages
    return messages.filter((msg) => !hidden.has(msg.info.id))
  }

  export function info(sessionID: string, raw: MessageV2.WithParts[], events: Event[]): Info["history"] | undefined {
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
        files: rollback.files,
        patchPartIDs: rollback.patchPartIDs,
        canUnrollback: canUnrollback(raw, rollback),
      },
    }
  }

  export async function liveInfo(sessionID: string): Promise<Info["history"] | undefined> {
    const [raw, events] = await Promise.all([rawMessages({ sessionID }), readEvents(sessionID)])
    return info(sessionID, raw, events)
  }

  async function latestInfo(sessionID: string, raw: MessageV2.WithParts[], events: Event[]) {
    await updateSessionHistory(sessionID, info(sessionID, raw, events))
    return info(sessionID, raw, events)
  }

  async function writeEvent(event: Event) {
    const session = await SessionManager.requireSession(event.sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    await Storage.write(
      StoragePath.sessionHistoryEvent(scopeID, asSessionID(event.sessionID), asHistoryID(event.id)),
      event,
    )
  }

  async function updateSessionHistory(sessionID: string, history: Info["history"] | undefined) {
    const { Session } = await import(".")
    await Session.update(sessionID, (draft) => {
      draft.history = history
    })
  }

  function isRollbackUser(msg: MessageV2.WithParts) {
    return msg.info.role === "user" && (msg.info as MessageV2.User).metadata?.synthetic !== true
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
    return !messages.some((msg) => msg.info.time.created > event.time.created)
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
