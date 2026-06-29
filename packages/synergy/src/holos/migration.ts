import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Global } from "@/global"
import { HolosAccounts } from "./accounts"
import { Log } from "@/util/log"
import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration"
import path from "path"
import fs from "fs/promises"

const log = Log.create({ service: "holos.migration" })

interface LegacyContact {
  id: string
  holosId?: string
  name: string
  bio?: string
  status?: string
  blocked?: boolean
  config?: {
    blocked?: boolean
    autoReply?: boolean
    autoInitiate?: boolean
    maxAutoTurns?: number
  }
  addedAt?: number
}

interface SimplifiedContact {
  id: string
  name: string
  blocked: boolean
  addedAt: number
}

function hasLegacyFields(contact: Record<string, unknown>): boolean {
  return "holosId" in contact || "bio" in contact || "status" in contact || "config" in contact
}

async function removePersistedAccountLabels(): Promise<number> {
  const filepath = Global.Path.authHolosAccounts
  const data = await Bun.file(filepath)
    .json()
    .catch(() => undefined)
  if (!data || typeof data !== "object" || Array.isArray(data)) return 0

  const accounts = (data as { accounts?: unknown }).accounts
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return 0

  let count = 0
  for (const account of Object.values(accounts)) {
    if (!account || typeof account !== "object" || Array.isArray(account)) continue
    if (!("label" in account)) continue
    delete (account as Record<string, unknown>).label
    count++
  }
  if (count === 0) return 0

  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await Bun.write(filepath, JSON.stringify(data, null, 2))
  await fs.chmod(filepath, 0o600).catch(() => {})
  return count
}

export const migrations: Migration[] = [
  {
    id: "20260620-migrate-holos-legacy-credentials",
    description: "Migrate legacy holos credentials from api-key.json to the multi-account holos-accounts.json store.",
    domain: "holos",
    async up() {
      const result = await HolosAccounts.migrateFromLegacy()
      if (result.migrated) {
        log.info("migrated legacy holos credentials to multi-account store")
      }
    },
  },
  {
    id: "20260629-holos-account-profile-source-of-truth",
    description: "Remove local Holos account labels so remote profile remains the identity source of truth.",
    domain: "holos",
    async up() {
      const count = await removePersistedAccountLabels()
      if (count > 0) {
        log.info("removed local holos account labels", { count })
      }
    },
  },
  {
    id: "20260619-holos-mailbox-cleanup",
    description:
      "Simplify contacts schema and delete legacy subsystems (friend_requests, message_queue, friend_reply, auto_turns)",
    domain: "holos",
    async up(progress) {
      // Phase 1: Delete legacy subsystems
      const legacyPaths = [
        { key: ["holos", "friend_requests"], label: "friend_requests" },
        { key: ["holos", "message_queue"], label: "message_queue" },
        { key: ["holos", "friend_reply"], label: "friend_reply" },
        { key: ["holos", "auto_turns"], label: "auto_turns" },
      ]

      for (const { key, label } of legacyPaths) {
        try {
          await Storage.removeTree(key)
          log.info("removed legacy subsystem", { subsystem: label })
        } catch (err) {
          log.warn("failed to remove legacy subsystem", {
            subsystem: label,
            error: String(err),
          })
        }
      }

      // Phase 2: Migrate contacts
      const contactKeys = await Storage.list(StoragePath.holosContactsRoot())

      if (contactKeys.length === 0) {
        progress(1, 1)
        log.info("no contacts to migrate")
        return
      }

      const total = contactKeys.length
      let done = 0

      for (const key of contactKeys) {
        try {
          const raw = await Storage.read<Record<string, unknown>>(key)
          if (!raw || !hasLegacyFields(raw)) {
            done++
            progress(done, total)
            continue
          }

          const legacy = raw as unknown as LegacyContact
          const effectiveId = legacy.holosId || legacy.id
          const name = legacy.name || "Unknown"
          const blocked = legacy.config?.blocked ?? (legacy.status === "blocked" || legacy.blocked || false)
          const addedAt = legacy.addedAt ?? Date.now()

          const simplified: SimplifiedContact = { id: effectiveId, name, blocked, addedAt }

          if (effectiveId !== legacy.id) {
            await Storage.write(StoragePath.holosContact(effectiveId), simplified)
            await Storage.remove(key)
            log.info("migrated contact with new id", {
              oldId: legacy.id,
              newId: effectiveId,
              name,
            })
          } else {
            await Storage.write(key, simplified)
          }
        } catch (err) {
          log.warn("failed to migrate contact", { key: key.join("/"), error: String(err) })
        }

        done++
        progress(done, total)
      }

      log.info("contact migration complete", { count: contactKeys.length })
    },
  },
  {
    id: "20260620-archive-holos-endpoint-sessions",
    description:
      "Archive all sessions with holos endpoints. The friend system was removed in favor of SMS relay; these sessions are no longer reachable.",
    domain: "holos",
    async up(progress) {
      const { Identifier } = await import("../id/id")
      const sessionScopeIDs = await Storage.scan(["sessions"])
      const allScopeIDs = [...sessionScopeIDs]
      if (!allScopeIDs.includes("home")) allScopeIDs.push("home")
      if (!allScopeIDs.includes("global")) allScopeIDs.push("global")

      const targetKeys: Array<[string[], string]> = []
      for (const scopeID of allScopeIDs) {
        const sid = Identifier.asScopeID(scopeID)
        const ids = await Storage.scan(StoragePath.sessionsRoot(sid))
        for (const id of ids) {
          const key = StoragePath.sessionInfo(sid, Identifier.asSessionID(id))
          try {
            const raw = await Storage.read<Record<string, unknown>>(key)
            if (!raw) continue
            const ep = raw.endpoint as { kind?: string } | undefined
            if (ep?.kind !== "holos") continue
            const t = (raw.time ?? {}) as Record<string, unknown>
            if (t.archived) continue
            targetKeys.push([[key].flat(), id])
          } catch {
            // skip unreadable
          }
        }
      }

      const total = targetKeys.length
      if (total === 0) {
        progress(1, 1)
        log.info("no holos endpoint sessions to archive")
        return
      }

      let done = 0
      for (const [key, sessionID] of targetKeys) {
        try {
          await Storage.update<Record<string, unknown>>(key, (draft) => {
            const t = (draft.time ?? {}) as Record<string, unknown>
            t.archived = Date.now()
            draft.time = t
          })
        } catch (err) {
          log.warn("failed to archive holos endpoint session", { sessionID, error: String(err) })
        }
        done++
        progress(done, total)
      }

      log.info("archived holos endpoint sessions", { count: total })
    },
  },
]

MigrationRegistry.register("holos", migrations)
