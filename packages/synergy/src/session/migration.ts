import { $ } from "bun"
import path from "path"
import fs from "fs/promises"
import { Identifier } from "@/id/id"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import type { Migration } from "@/migration"
import { SessionEndpoint } from "./endpoint"
import { Info } from "./types"
import { Log } from "@/util/log"
import { MessageV2 } from "./message-v2"
import { SessionNav } from "./nav"
import { SessionProgress } from "./progress"

import { MigrationRegistry } from "@/migration/registry"
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

async function repairPendingReplyFlags(progress: (current: number, total: number) => void) {
  const scopeIDs = await Storage.scan(["sessions"])
  const tasks: Array<{ scopeID: string; sessionID: string; info: Info }> = []

  for (const scopeID of scopeIDs) {
    const scope = Identifier.asScopeID(scopeID)
    const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(scope))
    const sessions = await Storage.readMany<Info>(
      sessionIDs.map((sessionID) => StoragePath.sessionInfo(scope, Identifier.asSessionID(sessionID))),
    )

    for (const info of sessions) {
      if (!info || info.time.archived || info.pendingReply !== true) continue
      tasks.push({ scopeID, sessionID: info.id, info })
    }
  }

  if (tasks.length === 0) return

  let done = 0
  let cleared = 0
  for (const { scopeID, sessionID, info } of tasks) {
    const scope = Identifier.asScopeID(scopeID)
    const sid = Identifier.asSessionID(sessionID)
    try {
      const messages = await MessageV2.filterCompacted(MessageV2.stream({ scopeID, sessionID }))
      const pendingReply = SessionProgress.pendingReply(messages)
      if (!pendingReply) {
        await Storage.write(StoragePath.sessionInfo(scope, sid), {
          ...info,
          pendingReply: undefined,
        })
        cleared++
      }
    } catch (error) {
      log.warn("failed to repair pendingReply flag", { scopeID, sessionID, error: String(error) })
    }

    done++
    progress(done, tasks.length)
  }

  log.info("pendingReply repair complete", { checked: tasks.length, cleared })
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
  {
    id: "20260423-session-page-index-and-last-exchange",
    description: "Build session page index per scope and backfill lastExchange on session info",
    async up(progress) {
      const scopeIDs = await Storage.scan(["sessions"])
      if (scopeIDs.length === 0) return

      let totalSessions = 0
      const scopeTasks: Array<{ scopeID: string; sessionIDs: string[] }> = []
      for (const scopeID of scopeIDs) {
        const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(Identifier.asScopeID(scopeID)))
        if (sessionIDs.length > 0) {
          scopeTasks.push({ scopeID, sessionIDs })
          totalSessions += sessionIDs.length
        }
      }

      if (totalSessions === 0) return

      let done = 0
      for (const { scopeID, sessionIDs } of scopeTasks) {
        const scope = Identifier.asScopeID(scopeID)

        // Batch read all session infos
        const keys = sessionIDs.map((id) => StoragePath.sessionInfo(scope, Identifier.asSessionID(id)))
        const sessions = await Storage.readMany<Info>(keys)

        // Build page index entries
        const entries: Array<{
          id: string
          updated: number
          created: number
          pinned: number
          archived: boolean
        }> = []

        for (let i = 0; i < sessions.length; i++) {
          const session = sessions[i]
          if (!session) continue

          entries.push({
            id: session.id,
            updated: session.time.updated,
            created: session.time.created,
            pinned: session.pinned ?? 0,
            archived: !!session.time.archived,
          })

          // Backfill lastExchange
          if (!session.lastExchange && !session.time.archived) {
            const lastExchange: NonNullable<Info["lastExchange"]> = {}
            const sID = Identifier.asSessionID(session.id)
            const msgIDs = await Storage.scan(StoragePath.sessionMessagesRoot(scope, sID)).catch(() => [])

            for (let mi = msgIDs.length - 1; mi >= 0; mi--) {
              const msgInfo = await Storage.read<MessageV2.Info>(
                StoragePath.messageInfo(scope, sID, Identifier.asMessageID(msgIDs[mi])),
              ).catch(() => undefined)
              if (!msgInfo) continue

              const partIDs = await Storage.scan(
                StoragePath.messageParts(scope, sID, Identifier.asMessageID(msgIDs[mi])),
              ).catch(() => [])
              const parts = (
                await Storage.readMany<MessageV2.Part>(
                  partIDs.map((pid) =>
                    StoragePath.messagePart(scope, sID, Identifier.asMessageID(msgIDs[mi]), Identifier.asPartID(pid)),
                  ),
                )
              ).filter((p): p is MessageV2.Part => p != null)

              if (!lastExchange.assistant && msgInfo.role === "assistant") {
                const text = MessageV2.extractText(parts, { maxLength: 200 })
                if (text) lastExchange.assistant = text
              }
              if (!lastExchange.user && msgInfo.role === "user") {
                const text = MessageV2.extractText(parts, { maxLength: 200 })
                if (text) lastExchange.user = text
              }
              if (lastExchange.user && lastExchange.assistant) break
            }

            if (lastExchange.user || lastExchange.assistant) {
              await Storage.write(StoragePath.sessionInfo(scope, sID), {
                ...session,
                lastExchange,
              })
            }
          }

          done++
          progress(done, totalSessions)
        }

        // Sort by updated desc and write page index
        entries.sort((a, b) => b.updated - a.updated)
        await Storage.write(StoragePath.sessionsPageIndex(scope), { entries })
      }

      log.info("session page index and lastExchange backfill complete", { totalSessions })
    },
  },
  {
    id: "20260423-session-page-index-parentid",
    description: "Add parentID to session page index entries",
    async up(progress) {
      const scopeIDs = await Storage.scan(["sessions"]).catch(() => [])
      let done = 0

      for (const scopeID of scopeIDs) {
        const scope = Identifier.asScopeID(scopeID)
        const indexPath = StoragePath.sessionsPageIndex(scope)
        const index = await Storage.read<{
          entries: Array<{
            id: string
            updated: number
            created: number
            pinned: number
            archived: boolean
            parentID?: string
          }>
        }>(indexPath).catch(() => null)
        if (!index?.entries?.length) {
          done++
          progress(done, scopeIDs.length)
          continue
        }

        let updated = false
        for (const entry of index.entries) {
          if (entry.parentID !== undefined) continue
          const info = await Storage.read<Info>(StoragePath.sessionInfo(scope, Identifier.asSessionID(entry.id))).catch(
            () => null,
          )
          if (info?.parentID) {
            entry.parentID = info.parentID
            updated = true
          }
        }

        if (updated) await Storage.write(indexPath, index)
        done++
        progress(done, scopeIDs.length)
      }
    },
  },
  {
    id: "20260617-session-nav-v2-category",
    description: "Build session navigation v2 indexes and backfill session categories",
    async up(progress) {
      const scopeIDs: string[] = await Storage.scan(["sessions"]).catch(() => [])
      const allScopeIDs = scopeIDs.includes("global") ? scopeIDs : ["global", ...scopeIDs]
      if (allScopeIDs.length === 0) return

      let done = 0
      for (const scopeID of allScopeIDs) {
        await SessionNav.buildNavIndex(scopeID).catch((error) => {
          log.warn("failed to build session nav v2 index during migration", { scopeID, error: String(error) })
        })
        done++
        progress(done, allScopeIDs.length)
      }
      log.info("session nav v2 index and category backfill complete", { scopes: allScopeIDs.length })
    },
  },
  {
    id: "20260617-dag-node-result-field",
    description: "Track DAG Node optional result field addition (schema-only, no data migration)",
    async up() {
      // Schema-only change: Node.result is optional and transparent to old data.
      // No data transformation needed.
    },
  },
  {
    id: "20260619-session-repair-stale-pending-reply",
    description: "Repair stale pendingReply flags on completed sessions",
    async up(progress) {
      await repairPendingReplyFlags(progress)
    },
  },
  {
    id: "20260619-snapshot-per-session",
    description:
      "Restructure snapshots from per-scope shared to per-session isolated repos with git alternates for backward hash resolution",
    async up(progress) {
      const { Global } = await import("../global")
      const snapshotRoot = Global.Path.snapshot
      const scopeIDs = await Storage.scan(["sessions"])
      if (scopeIDs.length === 0) return

      let done = 0
      for (const scopeID of scopeIDs) {
        const oldSharedPath = path.join(snapshotRoot, scopeID)
        const sharedPath = path.join(oldSharedPath, ".shared.old")

        // Detect old shared repo: bare-like git repo has HEAD at root (no .git/ wrapper)
        let sharedExists = false
        try {
          const stat = await fs.stat(path.join(oldSharedPath, "HEAD"))
          sharedExists = stat.isFile()
        } catch {
          sharedExists = false
        }

        // Two-step rename: move to sibling first, then into recreated scope dir
        if (sharedExists) {
          try {
            const tmpPath = path.join(snapshotRoot, `.tmp-${scopeID}`)
            await fs.rename(oldSharedPath, tmpPath)
            await fs.mkdir(oldSharedPath, { recursive: true })
            await fs.rename(tmpPath, sharedPath)
            log.info("renamed shared snapshot repo", { scopeID, to: sharedPath })
          } catch (err) {
            log.warn("failed to rename shared snapshot repo", { scopeID, error: String(err) })
          }
        }

        // Determine if shared old objects are reachable for alternates
        const hasSharedOld =
          sharedExists || ((await fs.stat(path.join(sharedPath, "HEAD")).catch(() => null))?.isFile() ?? false)

        const sessions = await Storage.scan(StoragePath.sessionsRoot(Identifier.asScopeID(scopeID)))

        for (const sessionID of sessions) {
          const sessionRepo = path.join(oldSharedPath, sessionID)

          // Idempotent: skip if repo already exists
          try {
            await fs.stat(path.join(sessionRepo, "HEAD"))
            continue
          } catch {
            // Repo does not exist, create it
          }

          await fs.mkdir(sessionRepo, { recursive: true })
          await $`git init`
            .env({ GIT_DIR: sessionRepo, ...process.env })
            .quiet()
            .nothrow()

          // Set git alternate to point to shared old objects for backward hash resolution
          if (hasSharedOld) {
            const objectsPath = path.join(sharedPath, "objects")
            const infoDir = path.join(sessionRepo, "objects", "info")
            await fs.mkdir(infoDir, { recursive: true })
            await fs.writeFile(path.join(infoDir, "alternates"), objectsPath + "\n")
          }
        }

        done++
        progress(done, scopeIDs.length)
      }

      log.info("snapshot per-session migration complete", { scopesHandled: scopeIDs.length })
    },
  },
]
MigrationRegistry.register("session", migrations)
