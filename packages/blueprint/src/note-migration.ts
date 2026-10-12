import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { PrimaryAgentUpgrade } from "@ericsanchezok/synergy-harness/agent/primary-identity-upgrade"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { NoteDocument, NoteMarkdown } from "@ericsanchezok/synergy-note"
import { migrateNoteHomeScope } from "@ericsanchezok/synergy-note/migration"

function upgrade(key: string[], value: Record<string, unknown>) {
  if (key[0] !== "notes" || key.length !== 3 || value.kind !== "blueprint") return
  const content = value.content as { type?: string; content?: unknown[] } | undefined
  if (typeof value.contentText === "string" && value.contentText.trim() && (!content || content.content?.length === 0))
    value.content = NoteMarkdown.fromMarkdown(value.contentText)
  delete value.contentText
  value.content = NoteDocument.normalize(value.content)
  value.archived ??= false
  if (value.blueprint && typeof value.blueprint === "object") {
    delete (value.blueprint as Record<string, unknown>).status
    PrimaryAgentUpgrade.fields(value.blueprint, ["defaultAgent", "auditAgent"])
  }
}

export const blueprintNoteMigrations: Migration[] = [
  {
    id: "20261012-blueprint-note-owner",
    description: "Upgrade retained Blueprint documents when their owner becomes available",
    scope: "global",
    execution: "startup",
    upgradeRecord: upgrade,
    async up(progress) {
      await migrateNoteHomeScope("blueprint")
      let count = 0
      for await (const { key, value } of Storage.records<Record<string, unknown>>({ kind: "notes" })) {
        if (key.length !== 3 || value.kind !== "blueprint") continue
        const before = JSON.stringify(value)
        upgrade(key, value)
        if (before !== JSON.stringify(value)) {
          await Storage.transaction(async (tx) => {
            await tx.write(key, value)
            await tx.remove(["notes", key[1], "_index"])
          })
        }
        progress(++count, 0)
      }
      progress(count, count)
    },
  },
]

export function registerBlueprintNoteMigrations() {
  MigrationRegistry.register("blueprint-note", blueprintNoteMigrations)
}
