import { z } from "zod"
import { Identifier } from "../id/id"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { MessageV2 } from "./message-v2"
import { UpgradeWork } from "../storage/upgrade-work"
import { SessionHistorySearch } from "./history-search"

export namespace SessionHistoryDisplay {
  const budget = 256 * 1024
  const State = z.object({
    version: z.literal(1),
    ready: z.boolean(),
    count: z.number().int().nonnegative(),
    generation: z.number(),
    cursor: z.string().optional(),
    sourceGeneration: z.number().optional(),
  })
  type State = z.infer<typeof State>
  export const ContentReference = z
    .object({ version: z.string(), bytes: z.number().int().nonnegative() })
    .meta({ ref: "SessionPartContentReference" })
  export const PartSummary = MessageV2.PartSummary
  export type PartSummary = z.infer<typeof PartSummary>
  export const MessageSummary = z
    .object({ info: MessageV2.Info, order: z.string(), version: z.string(), content: ContentReference })
    .meta({ ref: "SessionTimelineMessage" })
  export type MessageSummary = z.infer<typeof MessageSummary>
  export const TimelinePage = z
    .object({
      items: MessageSummary.array(),
      referencedRoots: MessageSummary.array(),
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
      total: z.number(),
      generation: z.number(),
    })
    .meta({ ref: "SessionTimelinePage" })
  export const PartPage = z
    .object({
      items: PartSummary.array(),
      nextCursor: z.string().nullable(),
      previousCursor: z.string().nullable(),
      hasMore: z.boolean(),
      hasEarlier: z.boolean(),
    })
    .meta({ ref: "SessionPartPage" })
  export const PartContent = z.object({ part: MessageV2.Part, version: z.string() }).meta({ ref: "SessionPartContent" })
  export const MessageDetails = z
    .object({ info: MessageV2.Info, version: z.string() })
    .meta({ ref: "SessionMessageDetails" })
  export const Conflict = NamedError.create("SessionDisplayConflict", z.object({ message: z.string() }))
  const preparing = Storage.state(() => new Map<string, Promise<void>>())
  const digest = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
  const key = StoragePath.sessionDisplayState
  const partStateKey = (scopeID: string, sessionID: string, messageID: string) => [
    "sessions",
    scopeID,
    sessionID,
    "display_parts_state",
    messageID,
  ]
  type PartsState = { ready: boolean; generation: number; cursor?: string; sourceGeneration?: number }

  export const summarizePart = MessageV2.summarizePart

  export function summarizeMessage(info: MessageV2.Info): MessageSummary {
    let metadataBytes = 0
    const metadata =
      info.metadata &&
      Object.fromEntries(
        Object.entries(info.metadata).filter(([key, value]) => {
          const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value) ?? "null")
          if (bytes > 8 * 1024 || metadataBytes + bytes > 16 * 1024) return false
          metadataBytes += bytes
          return true
        }),
      )
    const projected = { ...info, metadata }
    if (projected.role === "user") {
      projected.system = undefined
      projected.tools = undefined
      if (projected.origin)
        projected.origin = {
          ...projected.origin,
          label: projected.origin.label?.slice(0, 256),
          detail: projected.origin.detail?.slice(0, 1024),
        }
      if (projected.summary) {
        let bytes = 0
        projected.summary = {
          ...projected.summary,
          title: projected.summary.title?.slice(0, 256),
          body: projected.summary.body?.slice(0, 2048),
          diffs: projected.summary.diffs.flatMap((diff) => {
            const { patch: _patch, preview: _preview, ...compact } = diff
            bytes += Buffer.byteLength(JSON.stringify(compact))
            return bytes <= 64 * 1024 ? [compact] : []
          }),
        }
      }
    }
    if (projected.role === "assistant" && projected.error) {
      const error = projected.error
      if ("message" in error.data && typeof error.data.message === "string")
        projected.error = {
          ...error,
          data: { ...error.data, message: error.data.message.slice(0, 1024) },
        } as typeof error
      if (projected.error.name === "APIError")
        projected.error = {
          ...projected.error,
          data: {
            ...projected.error.data,
            responseBody: undefined,
            responseHeaders: undefined,
            metadata:
              projected.error.data.metadata &&
              Object.fromEntries(
                Object.entries(projected.error.data.metadata)
                  .filter(([key]) => key.length <= 256)
                  .slice(0, 16)
                  .map(([key, value]) => [key, value.slice(0, 256)]),
              ),
          },
        }
    }
    const text = JSON.stringify(projected)
    const original = JSON.stringify(info)
    return {
      info: projected,
      order: MessageV2.messageOrderMarker(info),
      version: digest(text),
      content: { version: digest(original), bytes: Buffer.byteLength(original) },
    }
  }

  async function state(scopeID: string, sessionID: string): Promise<State> {
    const [value] = await Storage.readMany<State>([key(scopeID, sessionID)])
    return value ?? { version: 1, ready: false, count: 0, generation: 0 }
  }

  export async function initialize(scopeID: string, sessionID: string) {
    await Storage.write(key(scopeID, sessionID), { version: 1, ready: true, count: 0, generation: 0 } satisfies State)
  }

  /**
   * Seed the display state for an on-access migration without forcing the
   * complete historical projection into the request that opened the Session.
   */
  export async function initializePending(scopeID: string, sessionID: string) {
    const [current] = await Storage.readMany<State>([key(scopeID, sessionID)])
    if (current) return
    await Storage.write(key(scopeID, sessionID), { version: 1, ready: false, count: 0, generation: 0 } satisfies State)
  }

  export async function invalidate(scopeID: string, sessionID: string) {
    const current = await state(scopeID, sessionID)
    await Storage.write(key(scopeID, sessionID), {
      ...current,
      ready: false,
      generation: current.generation + 1,
      cursor: undefined,
      sourceGeneration: undefined,
    })
  }

  export async function messageWritten(scopeID: string, info: MessageV2.Info, backfill = false) {
    const [previous] = await Storage.readMany<MessageSummary>([
      StoragePath.sessionDisplayMessage(scopeID, info.sessionID, info.id),
    ])
    const header = summarizeMessage(info)
    if (previous && previous.order !== header.order) {
      await Storage.remove(StoragePath.sessionDisplayTimeline(scopeID, info.sessionID, previous.order))
      await Storage.remove(StoragePath.sessionDisplayRoot(scopeID, info.sessionID, previous.order))
    }
    await Storage.write(StoragePath.sessionDisplayMessage(scopeID, info.sessionID, info.id), header)
    await Storage.write(StoragePath.sessionDisplayTimeline(scopeID, info.sessionID, header.order), header)
    if (info.role === "user" && info.isRoot !== false)
      await Storage.write(StoragePath.sessionDisplayRoot(scopeID, info.sessionID, header.order), header)
    else await Storage.remove(StoragePath.sessionDisplayRoot(scopeID, info.sessionID, header.order))
    if (backfill) return
    const current = await state(scopeID, info.sessionID)
    if (!previous && current.ready)
      await Storage.write(partStateKey(scopeID, info.sessionID, info.id), { ready: true, generation: 0 })
    await Storage.write(key(scopeID, info.sessionID), {
      ...current,
      count: current.count + Number(!previous),
      generation: current.generation + 1,
    })
  }

  export async function messageRemoved(scopeID: string, sessionID: string, messageID: string) {
    const [previous] = await Storage.readMany<MessageSummary>([
      StoragePath.sessionDisplayMessage(scopeID, sessionID, messageID),
    ])
    await Storage.remove(StoragePath.sessionDisplayMessage(scopeID, sessionID, messageID))
    await Storage.removeTree(StoragePath.sessionDisplayParts(scopeID, sessionID, messageID))
    await Storage.remove(partStateKey(scopeID, sessionID, messageID))
    if (!previous) return
    await Storage.remove(StoragePath.sessionDisplayTimeline(scopeID, sessionID, previous.order))
    await Storage.remove(StoragePath.sessionDisplayRoot(scopeID, sessionID, previous.order))
    const current = await state(scopeID, sessionID)
    await Storage.write(key(scopeID, sessionID), {
      ...current,
      count: Math.max(0, current.count - 1),
      generation: current.generation + 1,
    })
  }

  export async function partWritten(scopeID: string, part: MessageV2.Part) {
    await SessionHistorySearch.partWritten(scopeID, part)
    await Storage.write(
      StoragePath.sessionDisplayPart(scopeID, part.sessionID, part.messageID, part.id),
      summarizePart(part),
    )
    const [previous] = await Storage.readMany<PartsState>([partStateKey(scopeID, part.sessionID, part.messageID)])
    await Storage.write(partStateKey(scopeID, part.sessionID, part.messageID), {
      ...previous,
      ready: previous?.ready ?? false,
      generation: (previous?.generation ?? 0) + 1,
    })
  }

  export async function invalidatePart(scopeID: string, sessionID: string, messageID: string, partID: string) {
    await SessionHistorySearch.partWritten(scopeID, { sessionID, messageID, id: partID })
    const [previous] = await Storage.readMany<PartsState>([partStateKey(scopeID, sessionID, messageID)])
    await Storage.write(partStateKey(scopeID, sessionID, messageID), {
      ready: false,
      generation: (previous?.generation ?? 0) + 1,
    })
  }

  export async function partRemoved(scopeID: string, sessionID: string, messageID: string, partID: string) {
    await Storage.remove(StoragePath.sessionDisplayPart(scopeID, sessionID, messageID, partID))
    const [previous] = await Storage.readMany<PartsState>([partStateKey(scopeID, sessionID, messageID)])
    await Storage.write(partStateKey(scopeID, sessionID, messageID), {
      ...previous,
      ready: previous?.ready ?? false,
      generation: (previous?.generation ?? 0) + 1,
    })
  }

  export async function prepare(
    scopeID: string,
    sessionID: string,
    load: () => Promise<MessageV2.Info[]>,
    progress?: (current: number, total: number) => void,
  ) {
    if ((await state(scopeID, sessionID)).ready) return
    const identity = `${scopeID}/${sessionID}`
    const existing = preparing().get(identity)
    if (existing) return existing
    const pending = (async () => {
      for (;;) {
        const initial = await state(scopeID, sessionID)
        if (initial.ready) return
        const infos = await load()
        progress?.(0, infos.length)
        let interrupted = false
        const resume = initial.sourceGeneration === initial.generation ? initial.cursor : undefined
        const remaining = resume ? infos.filter((info) => MessageV2.messageOrderMarker(info) > resume) : infos
        for (let offset = 0; offset < remaining.length; offset += 64) {
          await UpgradeWork.checkpoint()
          const batch = remaining.slice(offset, offset + 64)
          await Storage.transaction(async () => {
            const current = await state(scopeID, sessionID)
            if (current.generation !== initial.generation) {
              interrupted = true
              return
            }
            const headers = batch.map(summarizeMessage)
            await Storage.transaction((tx) =>
              tx.writeMany(
                headers.flatMap((header) => [
                  { key: StoragePath.sessionDisplayMessage(scopeID, sessionID, header.info.id), value: header },
                  { key: StoragePath.sessionDisplayTimeline(scopeID, sessionID, header.order), value: header },
                  ...(header.info.role === "user" && header.info.isRoot !== false
                    ? [{ key: StoragePath.sessionDisplayRoot(scopeID, sessionID, header.order), value: header }]
                    : []),
                ]),
              ),
            )
            await Storage.write(key(scopeID, sessionID), {
              ...current,
              sourceGeneration: initial.generation,
              cursor: MessageV2.messageOrderMarker(batch.at(-1)!),
            })
          })
          if (interrupted) break
          progress?.(infos.length - remaining.length + offset + batch.length, infos.length)
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
        if (interrupted) continue
        const finished = await Storage.transaction(async () => {
          const current = await state(scopeID, sessionID)
          if (current.generation !== initial.generation) return false
          await Storage.write(key(scopeID, sessionID), {
            version: 1,
            ready: true,
            generation: initial.generation,
            count: infos.length,
          } satisfies State)
          return true
        })
        if (finished) return
      }
    })()
    preparing().set(identity, pending)
    void pending
      .finally(() => {
        if (preparing().get(identity) === pending) preparing().delete(identity)
      })
      .catch(() => {})
    return pending
  }

  export function cursorOrder(value: string) {
    return cursor(value).at(-1)!
  }

  /**
   * Prepare only the canonical message window needed by a foreground request.
   * The full display projection remains resumable through prepare(), while
   * this path keeps first-page reads independent from historical message size.
   */
  export async function prepareWindow(scopeID: string, sessionID: string, infos: MessageV2.Info[]) {
    if (!infos.length) return
    const headers = infos.map(summarizeMessage)
    const previous = await Storage.readMany<MessageSummary>(
      headers.map((header) => StoragePath.sessionDisplayMessage(scopeID, sessionID, header.info.id)),
    )
    const entries: Array<{ key: string[]; value: unknown }> = []
    const removals: string[][] = []
    for (const [index, header] of headers.entries()) {
      const prior = previous[index]
      if (
        prior?.order === header.order &&
        prior.version === header.version &&
        prior.content.version === header.content.version
      )
        continue
      if (prior && prior.order !== header.order) {
        removals.push(StoragePath.sessionDisplayTimeline(scopeID, sessionID, prior.order))
        removals.push(StoragePath.sessionDisplayRoot(scopeID, sessionID, prior.order))
      }
      entries.push({ key: StoragePath.sessionDisplayMessage(scopeID, sessionID, header.info.id), value: header })
      entries.push({ key: StoragePath.sessionDisplayTimeline(scopeID, sessionID, header.order), value: header })
      if (header.info.role === "user" && header.info.isRoot !== false)
        entries.push({ key: StoragePath.sessionDisplayRoot(scopeID, sessionID, header.order), value: header })
      else removals.push(StoragePath.sessionDisplayRoot(scopeID, sessionID, header.order))
    }
    if (!entries.length && !removals.length) return
    await Storage.transaction(async (tx) => {
      for (const removal of removals) await tx.remove(removal)
      if (entries.length) await tx.writeMany(entries)
    })
  }

  function cursor(value: string) {
    try {
      return z.object({ key: z.string().array().min(1) }).parse(JSON.parse(Buffer.from(value, "base64url").toString()))
        .key
    } catch {
      throw new Conflict({ message: "Invalid display cursor" })
    }
  }
  const encode = (key: string[]) => Buffer.from(JSON.stringify({ key })).toString("base64url")
  export async function latestRootCreated(scopeID: string, sessionID: string) {
    const [root] = await Storage.query<MessageSummary>({
      kind: "display_root",
      scopeID,
      sessionID,
      descending: true,
      limit: 1,
    })
    return root?.value.info.time.created ?? -Infinity
  }

  export async function latestRoot(
    scopeID: string,
    sessionID: string,
    visibility: { hidden: Set<string>; cut?: string },
  ) {
    let after: string[] | undefined
    for (;;) {
      const roots = await Storage.query<MessageSummary>({
        kind: "display_root",
        scopeID,
        sessionID,
        after,
        orderTo: visibility.cut,
        descending: true,
        limit: 100,
      })
      const root = roots.find((root) => !visibility.hidden.has(root.value.info.id))
      if (root) return root.value.info.rootID ?? root.value.info.id
      if (roots.length < 100) return
      after = roots.at(-1)!.key
    }
  }

  export async function header(scopeID: string, sessionID: string, messageID: string) {
    const [value] = await Storage.readMany<MessageSummary>([
      StoragePath.sessionDisplayMessage(scopeID, sessionID, messageID),
    ])
    return value
  }

  export async function timelinePage(
    input: { sessionID: string; cursor?: string; limit?: number; messageID?: string },
    visibility: { hidden: Set<string>; cut?: string },
    scopeID: string,
  ) {
    return Storage.snapshot(async () => {
      const current = await state(scopeID, input.sessionID)
      const hidden = await Storage.readMany<MessageSummary>(
        [...visibility.hidden].map((id) => StoragePath.sessionDisplayMessage(scopeID, input.sessionID, id)),
      )
      const total =
        (visibility.cut
          ? await Storage.count({
              prefix: StoragePath.sessionMessageOrderMarkersRoot(
                Identifier.asScopeID(scopeID),
                Identifier.asSessionID(input.sessionID),
              ),
              orderTo: visibility.cut,
            })
          : current.ready
            ? current.count
            : await Storage.count({ kind: "message", scopeID, sessionID: input.sessionID })) -
        hidden.filter((value) => value && (!visibility.cut || value.order < visibility.cut)).length
      const after = input.cursor ? cursor(input.cursor) : undefined
      if (
        after &&
        (after[0] !== "sessions" ||
          after[1] !== scopeID ||
          after[2] !== input.sessionID ||
          after[3] !== "display_timeline")
      )
        throw new Conflict({ message: "Display cursor belongs to another Session" })
      const target = input.messageID ? await header(scopeID, input.sessionID, input.messageID) : undefined
      const records = await Storage.query<MessageSummary>({
        kind: "display_timeline",
        scopeID,
        sessionID: input.sessionID,
        after,
        descending: true,
        limit: 100,
        orderTo: target ? target.order + "\uffff" : visibility.cut,
      })
      const limit = Math.max(1, Math.min(100, input.limit ?? 50))
      const items: MessageSummary[] = []
      const roots = new Map<string, MessageSummary>()
      let bytes = 512
      let last: string[] | undefined
      for (const record of records) {
        if (visibility.hidden.has(record.value.info.id) || (visibility.cut && record.value.order >= visibility.cut)) {
          last = record.key
          continue
        }
        const entry = record.value
        const rootID = entry.info.rootID
        const root =
          rootID && rootID !== entry.info.id && !roots.has(rootID)
            ? await header(scopeID, input.sessionID, rootID)
            : undefined
        const size = Buffer.byteLength(JSON.stringify(entry)) + (root ? Buffer.byteLength(JSON.stringify(root)) : 0)
        if (bytes + size > budget) {
          if (!items.length) throw new Conflict({ message: "Message metadata exceeds display budget" })
          break
        }
        bytes += size
        items.push(entry)
        if (root) roots.set(root.info.id, root)
        last = record.key
        if (items.length === limit) break
      }
      const ids = new Set(items.map((item) => item.info.id))
      const hasMore =
        records.length === 100 || (last !== undefined && records.some((record) => record.key.at(-1)! < last!.at(-1)!))
      return {
        items: items.reverse(),
        referencedRoots: [...roots.values()].filter((root) => !ids.has(root.info.id)),
        nextCursor: hasMore && last ? encode(last) : null,
        hasMore,
        total,
        generation: current.generation,
      }
    })
  }

  export async function partPage(
    input: {
      sessionID: string
      messageID: string
      cursor?: string
      limit?: number
      partID?: string
      older?: boolean
    },
    scopeID: string,
  ) {
    const after = input.cursor ? cursor(input.cursor) : undefined
    if (
      after &&
      (after[0] !== "sessions" || after[1] !== scopeID || after[2] !== input.sessionID || after[4] !== input.messageID)
    )
      throw new Conflict({ message: "Part cursor belongs to another Message" })
    const [prepared] = await Storage.readMany<PartsState>([partStateKey(scopeID, input.sessionID, input.messageID)])
    const limit = Math.max(1, Math.min(100, input.limit ?? 100))
    const descending = Boolean(input.partID || input.older)
    const query = {
      scopeID,
      sessionID: input.sessionID,
      messageID: input.messageID,
      limit: limit + 1,
      descending,
      orderTo: input.partID ? input.partID + "\uffff" : undefined,
    }
    const records = prepared?.ready
      ? await Storage.query<PartSummary>({
          ...query,
          kind: "display_part",
          after: after && StoragePath.sessionDisplayPart(scopeID, input.sessionID, input.messageID, after.at(-1)!),
        })
      : await Storage.query<MessageV2.Part>({
          ...query,
          kind: "part",
          after:
            after &&
            StoragePath.messagePart(
              Identifier.asScopeID(scopeID),
              Identifier.asSessionID(input.sessionID),
              Identifier.asMessageID(input.messageID),
              Identifier.asPartID(after.at(-1)!),
            ),
        })
    const projected = records.map((record) => ("content" in record.value ? record.value : summarizePart(record.value)))
    const selected: PartSummary[] = []
    let bytes = 256
    for (let index = 0; index < Math.min(limit, records.length); index++) {
      const summary = projected[index]!
      const size = Buffer.byteLength(JSON.stringify(summary))
      if (bytes + size > budget) break
      selected.push(summary)
      bytes += size
    }
    const selectedRecords = records.slice(0, selected.length)
    const items = descending ? selected.reverse() : selected
    const ordered = descending ? selectedRecords.reverse() : selectedRecords
    const kind = prepared?.ready ? "display_part" : "part"
    const hasMore =
      ordered.length > 0 &&
      (
        await Storage.queryKeys({
          kind,
          scopeID,
          sessionID: input.sessionID,
          messageID: input.messageID,
          after: ordered.at(-1)!.key,
          limit: 1,
        })
      ).length > 0
    const hasEarlier =
      ordered.length > 0 &&
      (
        await Storage.queryKeys({
          kind,
          scopeID,
          sessionID: input.sessionID,
          messageID: input.messageID,
          after: ordered[0]!.key,
          descending: true,
          limit: 1,
        })
      ).length > 0
    if (!prepared?.ready)
      await Storage.transaction(async (tx) => {
        const [current] = await Storage.readMany<PartsState>([partStateKey(scopeID, input.sessionID, input.messageID)])
        const generation = current?.generation ?? 0
        if (generation !== (prepared?.generation ?? 0)) return
        await tx.writeMany(
          projected.map((summary) => ({
            key: StoragePath.sessionDisplayPart(scopeID, input.sessionID, input.messageID, summary.id),
            value: summary,
          })),
        )
        const continuous =
          !descending && (!after || (current?.sourceGeneration === generation && current.cursor === after.at(-1)))
        if (continuous)
          await Storage.write(partStateKey(scopeID, input.sessionID, input.messageID), {
            ready: !hasMore,
            generation,
            cursor: items.at(-1)?.id,
            sourceGeneration: generation,
          } satisfies PartsState)
      })
    return {
      items,
      hasMore,
      hasEarlier,
      nextCursor: hasMore && ordered.length ? encode(ordered.at(-1)!.key) : null,
      previousCursor: hasEarlier && ordered.length ? encode(ordered[0]!.key) : null,
    }
  }

  export async function partContent(
    input: { sessionID: string; messageID: string; partID: string; version?: string },
    scopeID: string,
  ) {
    const part = await Storage.read<MessageV2.Part>(
      StoragePath.messagePart(
        Identifier.asScopeID(scopeID),
        Identifier.asSessionID(input.sessionID),
        Identifier.asMessageID(input.messageID),
        Identifier.asPartID(input.partID),
      ),
    )
    const version = summarizePart(part).content.version
    if (input.version && version !== input.version)
      throw new Conflict({ message: "Part content changed; refresh its summary" })
    return { part, version }
  }

  export async function messageDetails(
    input: { sessionID: string; messageID: string; version?: string },
    scopeID: string,
  ) {
    const info = await Storage.read<MessageV2.Info>(
      StoragePath.messageInfo(
        Identifier.asScopeID(scopeID),
        Identifier.asSessionID(input.sessionID),
        Identifier.asMessageID(input.messageID),
      ),
    )
    const version = digest(JSON.stringify(info))
    if (input.version && version !== input.version)
      throw new Conflict({ message: "Message content changed; refresh its summary" })
    return { info, version }
  }
}
