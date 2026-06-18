import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Log } from "../util/log"
import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration"

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

export const migrations: Migration[] = [
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
]

MigrationRegistry.register("holos", migrations)
