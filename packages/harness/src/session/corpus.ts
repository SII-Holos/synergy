import { createHash } from "node:crypto"
import { z } from "zod"
import { Identifier } from "../id/id"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { UpgradeWork } from "../storage/upgrade-work"
import { SessionHistory } from "./history"
import { SessionHistorySearch } from "./history-search"
import { MessageV2 } from "./message-v2"
import { PartContent } from "./part-content"
import { SessionSearchIndex } from "./search-index"
import type { Info } from "./types"

export namespace SessionCorpus {
  export const Reference = z.object({
    scopeID: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
    family: z.string(),
    sources: z.array(z.object({ key: z.array(z.string()), revision: z.string().nullable() })),
  })
  export type Reference = z.infer<typeof Reference>
  export interface Message {
    reference: Reference
    info: MessageV2.Info
    parts: MessageV2.TextPart[]
    text: string
  }
  export interface PreparationCursor {
    after?: string[]
    current?: string[]
  }
  const sessionKey = (scopeID: string, sessionID: string) =>
    StoragePath.sessionInfo(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID))
  const messageKey = (scopeID: string, sessionID: string, messageID: string) =>
    StoragePath.messageInfo(
      Identifier.asScopeID(scopeID),
      Identifier.asSessionID(sessionID),
      Identifier.asMessageID(messageID),
    )
  const partKey = (scopeID: string, sessionID: string, messageID: string, partID: string) =>
    StoragePath.messagePart(
      Identifier.asScopeID(scopeID),
      Identifier.asSessionID(sessionID),
      Identifier.asMessageID(messageID),
      Identifier.asPartID(partID),
    )

  export async function sessions(input: { cursor?: string[]; limit?: number } = {}) {
    const records = await Storage.query<Info>({
      kind: "session",
      after: input.cursor,
      descending: true,
      limit: input.limit ?? 32,
    })
    return { items: records.map((record) => record.value), cursor: records.at(-1)?.key }
  }

  export function prepare(input: {
    scopeID: string
    sessionID: string
    cursor?: PreparationCursor
    signal?: AbortSignal
  }) {
    return UpgradeWork.run({ background: true, sessionID: input.sessionID, signal: input.signal }, async () => {
      await UpgradeWork.checkpoint()
      const keys = input.cursor?.current
        ? [input.cursor.current]
        : await Storage.queryKeys({
            kind: "part",
            scopeID: input.scopeID,
            sessionID: input.sessionID,
            after: input.cursor?.after,
            limit: 16,
          })
      const summaries = await Storage.readMany<MessageV2.PartSummary>(
        keys.map((key) => StoragePath.sessionDisplayPart(input.scopeID, input.sessionID, key[4]!, key[6]!)),
      )
      let after = input.cursor?.after
      let legacyReads = 0
      for (const [index, key] of keys.entries()) {
        await UpgradeWork.checkpoint()
        let summary = summaries[index]
        if (!summary) {
          const record = await Storage.versioned<PartContent.Stored>(key).catch((error) => {
            if (error instanceof Storage.NotFoundError) return undefined
            throw error
          })
          if (record) {
            legacyReads++
            summary = PartContent.summary(record.value)
            const prepared = summary
            await Storage.transaction(async (tx) => {
              if ((await tx.revisions([key]))[0] === record.revision)
                await tx.write(
                  StoragePath.sessionDisplayPart(input.scopeID, input.sessionID, key[4]!, key[6]!),
                  prepared,
                )
            })
          }
        }
        if (summary?.type === "text" && !(await SessionHistorySearch.preparePart(key, input.signal)))
          return { ready: false, cursor: { after, current: key }, legacyReads }
        after = key
      }
      return { ready: keys.length === 0, cursor: { after }, legacyReads }
    })
  }

  async function textParts(scopeID: string, sessionID: string, messageID: string) {
    const keys = await Storage.queryKeys({ kind: "part", scopeID, sessionID, messageID, limit: 10000 })
    const summaries = await Storage.readMany<MessageV2.PartSummary>(
      keys.map((key) => StoragePath.sessionDisplayPart(scopeID, sessionID, messageID, key[6]!)),
    )
    const selected = keys.filter((_key, index) => summaries[index]?.type === "text")
    const records = await Storage.readMany<PartContent.Stored>(selected)
    const parts: MessageV2.TextPart[] = []
    for (const [index, record] of records.entries()) {
      if (!record || MessageV2.isSystemPart(record)) continue
      const part = await PartContent.hydrate(selected[index]!, record)
      if (part.type === "text") parts.push(part)
    }
    return parts
  }

  async function read(session: Info, info: MessageV2.Info): Promise<Message> {
    const parts = await textParts(session.scope.id, session.id, info.id)
    const [canonical] = MessageV2.deriveSemantics([{ info, parts }])
    const ancestry: string[][] = []
    const seen = new Set<string>([session.id])
    let ancestor = session
    let family = session.id
    while (ancestor.forkedFrom && !seen.has(ancestor.forkedFrom.sessionID)) {
      family = ancestor.forkedFrom.sessionID
      seen.add(family)
      const indexKey = StoragePath.sessionIndex(Identifier.asSessionID(family))
      ancestry.push(indexKey)
      const [index] = await Storage.readMany<{ scopeID: string }>([indexKey])
      if (!index) break
      const key = sessionKey(index.scopeID, family)
      ancestry.push(key)
      const [parent] = await Storage.readMany<Info>([key])
      if (!parent) break
      ancestor = parent
    }
    const keys = [
      sessionKey(session.scope.id, session.id),
      StoragePath.sessionMessageOrderState(Identifier.asScopeID(session.scope.id), Identifier.asSessionID(session.id)),
      messageKey(session.scope.id, session.id, info.id),
      StoragePath.sessionDisplayPartsState(session.scope.id, session.id, info.id),
      ...parts.map((part) => partKey(session.scope.id, session.id, info.id, part.id)),
      ...ancestry,
    ]
    const versions = await Storage.revisions(keys)
    return {
      reference: {
        scopeID: session.scope.id,
        sessionID: session.id,
        messageID: info.id,
        family,
        sources: keys.map((key, index) => ({ key, revision: versions[index]?.toString() ?? null })),
      },
      info: canonical!.info,
      parts,
      text: parts.map((part) => part.text).join("\n\n"),
    }
  }

  export async function current(references: Reference[]) {
    const sources = references.flatMap((reference) => reference.sources)
    const revisions = await Storage.revisions(sources.map((source) => source.key))
    return sources.every((source, index) => source.revision === (revisions[index]?.toString() ?? null))
  }

  export function hydrate(references: Reference[]) {
    return Storage.snapshot(async () => {
      const keys = references.flatMap((ref) => [
        sessionKey(ref.scopeID, ref.sessionID),
        messageKey(ref.scopeID, ref.sessionID, ref.messageID),
      ])
      const values = await Storage.readMany<Info | MessageV2.Info>(keys)
      const result: Array<Message | undefined> = []
      for (const [index, ref] of references.entries()) {
        const session = values[index * 2] as Info | undefined
        const info = values[index * 2 + 1] as MessageV2.Info | undefined
        result.push(session && info && (await current([ref])) ? await read(session, info) : undefined)
      }
      return result
    })
  }

  export async function query(input: {
    terms: string[]
    roles?: Array<"user" | "assistant">
    origins?: MessageV2.OriginType[]
    before?: number
    cursor?: string
    limit?: number
    signal?: AbortSignal
  }) {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          1,
          SessionSearchIndex.TOKENIZER_VERSION,
          input.terms,
          input.roles,
          input.origins,
          input.before,
        ]),
      )
      .digest("hex")
    const previous = input.cursor
      ? z
          .object({ fingerprint: z.literal(fingerprint), position: z.string() })
          .parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString()))
      : undefined
    const limit = Math.max(1, Math.min(100, input.limit ?? 24))
    return Storage.snapshot(async (tx) => {
      const items: Array<{
        reference: Reference
        text: string
        role: "user" | "assistant"
        score: number
        created: number
      }> = []
      const sessions = new Map<string, { info: Info; messages: Map<string, MessageV2.Info> }>()
      const seen = new Set<string>()
      let position = previous?.position
      let more = false
      let scanned = 0
      for (let batch = 0; batch < 8; batch++) {
        input.signal?.throwIfAborted()
        const page = await tx.searchTextProjection({
          query: input.terms[0] ?? "",
          terms: input.terms,
          cursor: position,
          limit: limit - items.length,
        })
        scanned += page.scanned
        for (const hit of page.items) {
          const scopeID = hit.key[1]!,
            sessionID = hit.key[2]!,
            messageID = hit.key[4]!
          const identity = `${scopeID}/${sessionID}`
          if (seen.has(`${identity}/${messageID}`)) continue
          if (!sessions.has(identity)) {
            const [session] = await tx.readMany<Info>([sessionKey(scopeID, sessionID)])
            if (!session) continue
            sessions.set(identity, {
              info: session,
              messages: new Map((await SessionHistory.effectiveMessageInfos(session)).map((info) => [info.id, info])),
            })
          }
          const session = sessions.get(identity)!
          const info = session.messages.get(messageID)
          if (
            !info ||
            info.visible === false ||
            info.includeInContext === false ||
            (input.before !== undefined && info.time.created >= input.before) ||
            (input.roles && !input.roles.includes(info.role)) ||
            (input.origins &&
              (info.role !== "user" ||
                !input.origins.includes((info.origin ?? MessageV2.originFromMetadata(info.metadata)).type)))
          )
            continue
          const message = await read(session.info, info)
          if (!message.text) continue
          seen.add(`${identity}/${messageID}`)
          items.push({
            reference: message.reference,
            text: hit.text,
            role: info.role,
            created: info.time.created,
            score: hit.score!,
          })
          if (items.length >= limit) {
            position = hit.cursor
            more = hit !== page.items.at(-1) || page.nextCursor !== null
            break
          }
        }
        if (items.length >= limit) break
        position = page.nextCursor ?? undefined
        more = Boolean(position)
        if (!more) break
      }
      return {
        items,
        scanned,
        nextCursor:
          more && position ? Buffer.from(JSON.stringify({ fingerprint, position })).toString("base64url") : null,
      }
    })
  }

  export function neighborhood(reference: Reference, before?: number) {
    return Storage.snapshot(async () => {
      if (!(await current([reference]))) return undefined
      const [session] = await Storage.readMany<Info>([sessionKey(reference.scopeID, reference.sessionID)])
      if (!session) return undefined
      const infos = (await SessionHistory.effectiveMessageInfos(session)).filter(
        (info) =>
          info.visible !== false &&
          info.includeInContext !== false &&
          (before === undefined || info.time.created < before),
      )
      const at = infos.findIndex((info) => info.id === reference.messageID)
      if (at < 0) return undefined
      const adjacent = infos[at - 1]
      const previous =
        adjacent?.role === "assistant" &&
        !adjacent.summary &&
        !adjacent.error &&
        adjacent.finish &&
        !["tool-calls", "unknown"].includes(adjacent.finish)
          ? adjacent
          : undefined
      const following = infos[at + 1]
      const next = following?.role === "user" && MessageV2.isHumanInput(following) ? following : undefined
      return {
        message: await read(session, infos[at]!),
        previous: previous && (await read(session, previous)),
        next: next && (await read(session, next)),
      }
    })
  }

  export function messages(input: { scopeID: string; sessionID: string; cursor?: string[]; limit?: number }) {
    return Storage.snapshot(async (tx) => {
      const [session] = await tx.readMany<Info>([sessionKey(input.scopeID, input.sessionID)])
      if (!session) return { items: [], cursor: undefined }
      const records = await tx.query<MessageV2.Info>({
        kind: "message",
        scopeID: input.scopeID,
        sessionID: input.sessionID,
        after: input.cursor,
        limit: input.limit ?? 32,
      })
      const effective = new Set((await SessionHistory.effectiveMessageInfos(session)).map((info) => info.id))
      const items: Message[] = []
      for (const record of records) if (effective.has(record.value.id)) items.push(await read(session, record.value))
      return { items, cursor: records.at(-1)?.key }
    })
  }
}
