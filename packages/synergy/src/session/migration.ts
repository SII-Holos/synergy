import { Identifier } from "@/id/id"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import type { Migration } from "@/migration"
import { SessionEndpoint } from "./endpoint"
import { Info } from "./types"
import { Log } from "@/util/log"
import { MessageV2 } from "./message-v2"

const log = Log.create({ service: "session.migration" })

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function compact<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries) as T
}

function normalizeLegacyHolosMetadata(metadata: Record<string, unknown>): {
  metadata: Record<string, unknown> | undefined
  changed: boolean
} {
  const original = JSON.stringify(metadata)
  const next: Record<string, unknown> = { ...metadata }
  const legacyChannel = asRecord(metadata.channel)
  const holos = compact({
    inbound:
      metadata.inboundSurface === "holos" || metadata.fromChannel === true || legacyChannel?.type === "holos"
        ? true
        : undefined,
    senderId: asString(metadata.holosSenderId) ?? asString(legacyChannel?.senderId),
    senderName: asString(metadata.holosSenderName) ?? asString(legacyChannel?.senderName),
    messageId: asString(metadata.holosMessageId),
    replyToMessageId: asString(metadata.replyToHolosMessageId),
  })
  const quote = compact({
    messageId: asString(metadata.replyToMessageId),
    text: asString(metadata.quotedText),
    senderName: asString(metadata.quotedSenderName),
  })

  delete next.inboundSurface
  delete next.holosSenderId
  delete next.holosSenderName
  delete next.holosMessageId
  delete next.replyToHolosMessageId
  delete next.replyToMessageId
  delete next.quotedText
  delete next.quotedSenderName
  delete next.fromChannel
  delete next.channel

  const currentHolos = asRecord(metadata.holos)
  const currentQuote = asRecord(metadata.quote)

  if (currentHolos)
    next.holos = compact({
      inbound: currentHolos.inbound === true ? true : holos?.inbound,
      senderId: asString(currentHolos.senderId) ?? holos?.senderId,
      senderName: asString(currentHolos.senderName) ?? holos?.senderName,
      messageId: asString(currentHolos.messageId) ?? holos?.messageId,
      replyToMessageId: asString(currentHolos.replyToMessageId) ?? holos?.replyToMessageId,
    })
  else if (holos) next.holos = holos

  if (currentQuote)
    next.quote = compact({
      messageId: asString(currentQuote.messageId) ?? quote?.messageId,
      text: asString(currentQuote.text) ?? quote?.text,
      senderName: asString(currentQuote.senderName) ?? quote?.senderName,
    })
  else if (quote) next.quote = quote

  const normalized = compact(next)
  return { metadata: normalized, changed: JSON.stringify(normalized) !== original }
}

export const migrations: Migration[] = [
  {
    id: "20260411-session-endpoint-index",
    description: "Backfill endpoint session index and remove legacy channel index",
    async up(progress) {
      const scopeIDs = await Storage.scan(["sessions"])
      const tasks: Array<{ scopeID: string; sessionID: string }> = []

      for (const scopeID of scopeIDs) {
        const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(Identifier.asScopeID(scopeID)))
        for (const sessionID of sessionIDs) {
          tasks.push({ scopeID, sessionID })
        }
      }

      if (tasks.length === 0) return

      let done = 0
      for (const { scopeID, sessionID } of tasks) {
        const scope = Identifier.asScopeID(scopeID)
        const session = Identifier.asSessionID(sessionID)
        const info = await Storage.read<Info>(StoragePath.sessionInfo(scope, session)).catch(() => undefined)

        if (info?.endpoint && !info.time.archived) {
          const endpointKey = SessionEndpoint.toKey(info.endpoint)
          await Storage.write(StoragePath.endpointSession(endpointKey, session), {
            sessionID: info.id,
            scopeID,
          })
        }

        done++
        progress(done, tasks.length)
      }

      await Storage.removeTree(["channel_session"]).catch(() => undefined)
      log.info("endpoint session index backfill complete", { total: tasks.length })
    },
  },
  {
    id: "20260411-holos-message-metadata-shape",
    description: "Normalize legacy Holos message metadata into grouped fields",
    async up(progress) {
      const scopeIDs = await Storage.scan(["sessions"])
      const tasks: Array<{ scopeID: string; sessionID: string; messageID: string }> = []

      for (const scopeID of scopeIDs) {
        const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(Identifier.asScopeID(scopeID)))
        for (const sessionID of sessionIDs) {
          const messageIDs = await Storage.scan(
            StoragePath.sessionMessagesRoot(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID)),
          ).catch(() => [])
          for (const messageID of messageIDs) {
            tasks.push({ scopeID, sessionID, messageID })
          }
        }
      }

      if (tasks.length === 0) return

      let done = 0
      for (const { scopeID, sessionID, messageID } of tasks) {
        const scope = Identifier.asScopeID(scopeID)
        const session = Identifier.asSessionID(sessionID)
        const message = Identifier.asMessageID(messageID)
        const info = await Storage.read<MessageV2.Info>(StoragePath.messageInfo(scope, session, message)).catch(
          () => undefined,
        )
        if (info?.metadata) {
          const metadata = info.metadata as Record<string, unknown>
          const normalized = normalizeLegacyHolosMetadata(metadata)
          if (normalized.changed) {
            await Storage.write(StoragePath.messageInfo(scope, session, message), {
              ...info,
              metadata: normalized.metadata,
            })
          }
        }

        done++
        progress(done, tasks.length)
      }

      log.info("holos message metadata normalization complete", { total: tasks.length })
    },
  },
]
