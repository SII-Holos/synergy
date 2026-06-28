import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Identifier } from "../id/id"
import { NoteMarkdown } from "./markdown"
import { NoteDocument } from "./document"
import { Log } from "../util/log"
import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration"

const log = Log.create({ service: "note.migration" })

export const migrations: Migration[] = [
  {
    id: "20260617-note-drop-contentText",
    description: "Remove contentText from stored notes; rebuild indices with derived searchText",
    domain: "note",
    async up(progress) {
      const scopeIDs = await Storage.scan(["notes"])
      log.info("found note scope dirs", { count: scopeIDs.length })

      let totalNotes = 0
      let migratedContentTextOnly = 0

      for (const sid of scopeIDs) {
        const s = Identifier.asScopeID(sid)
        const ids = await Storage.scan(StoragePath.notesRoot(s))
        totalNotes += ids.filter((id) => !id.startsWith("_")).length
      }

      let done = 0

      for (const sid of scopeIDs) {
        const s = Identifier.asScopeID(sid)
        const ids = await Storage.scan(StoragePath.notesRoot(s))
        const noteIDs = ids.filter((id) => !id.startsWith("_"))

        for (const noteID of noteIDs) {
          const notePath = StoragePath.note(s, noteID)
          try {
            const raw = await Storage.read<Record<string, unknown>>(notePath)

            // Derive content from contentText when content is empty
            if (raw.contentText && typeof raw.contentText === "string" && raw.contentText.trim()) {
              const contentObj = raw.content as { type?: string; content?: unknown[] } | undefined
              if (!raw.content || (contentObj?.type === "doc" && (contentObj?.content?.length ?? 0) === 0)) {
                raw.content = NoteMarkdown.fromMarkdown(raw.contentText as string)
                migratedContentTextOnly++
              }
            }

            // Always delete contentText from stored JSON
            delete raw.contentText

            await Storage.write(notePath, raw)
          } catch (err) {
            log.warn("failed to migrate note", { scopeID: sid, noteID, error: String(err) })
          }

          done++
          if (done % 10 === 0 || done === totalNotes) {
            progress(done, totalNotes)
          }
        }

        // Rebuild index for this scope to include searchText
        try {
          const indexPath = StoragePath.note(s, "_index")
          await Storage.remove(indexPath).catch(() => {})
        } catch {
          // Index may not exist — that's fine
        }
      }

      log.info("migration complete", {
        totalNotes,
        migratedContentTextOnly,
        scopes: scopeIDs.length,
      })
    },
  },
  {
    id: "20260623-note-add-blueprint-fields",
    description: "Add note kind to existing notes; set kind default to 'note'",
    domain: "note",
    async up(progress) {
      const scopeIDs = await Storage.scan(["notes"])
      let totalNotes = 0
      for (const sid of scopeIDs) {
        const s = Identifier.asScopeID(sid)
        const ids = await Storage.scan(StoragePath.notesRoot(s))
        totalNotes += ids.filter((id) => !id.startsWith("_")).length
      }
      let done = 0
      for (const sid of scopeIDs) {
        const s = Identifier.asScopeID(sid)
        const ids = await Storage.scan(StoragePath.notesRoot(s))
        const noteIDs = ids.filter((id) => !id.startsWith("_"))
        for (const noteID of noteIDs) {
          const notePath = StoragePath.note(s, noteID)
          try {
            const raw = await Storage.read<Record<string, unknown>>(notePath)
            if (!raw.kind) raw.kind = "note"
            await Storage.write(notePath, raw)
          } catch (err) {
            log.warn("failed to migrate note blueprint fields", { scopeID: sid, noteID, error: String(err) })
          }
          done++
          if (done % 10 === 0 || done === totalNotes) {
            progress(done, totalNotes)
          }
        }
      }
      log.info("blueprint fields migration complete", { totalNotes, scopes: scopeIDs.length })
    },
  },
  {
    id: "20260623-note-rebuild-blueprint-meta",
    description: "Rebuild note metadata indices with blueprint fields",
    domain: "note",
    dependsOn: ["20260623-note-add-blueprint-fields"],
    async up(progress) {
      const scopeIDs = await Storage.scan(["notes"])
      let done = 0
      for (const sid of scopeIDs) {
        const s = Identifier.asScopeID(sid)
        await Storage.remove(StoragePath.note(s, "_index")).catch(() => {})
        done++
        progress(done, scopeIDs.length)
      }
      log.info("blueprint metadata index rebuild scheduled", { scopes: scopeIDs.length })
    },
  },
  {
    id: "20260624-note-remove-blueprint-status",
    description: "Remove deprecated blueprint status metadata from notes",
    domain: "note",
    dependsOn: ["20260623-note-rebuild-blueprint-meta"],
    async up(progress) {
      const scopeIDs = await Storage.scan(["notes"])
      let totalNotes = 0
      for (const sid of scopeIDs) {
        const s = Identifier.asScopeID(sid)
        const ids = await Storage.scan(StoragePath.notesRoot(s))
        totalNotes += ids.filter((id) => !id.startsWith("_")).length
      }

      let done = 0
      let changed = 0
      for (const sid of scopeIDs) {
        const s = Identifier.asScopeID(sid)
        const ids = await Storage.scan(StoragePath.notesRoot(s))
        const noteIDs = ids.filter((id) => !id.startsWith("_"))
        let rebuiltIndex = false

        for (const noteID of noteIDs) {
          const notePath = StoragePath.note(s, noteID)
          try {
            const raw = await Storage.read<Record<string, unknown>>(notePath)
            const blueprint = raw.blueprint as Record<string, unknown> | undefined
            if (blueprint && "status" in blueprint) {
              delete blueprint.status
              if (raw.kind === "blueprint") {
                raw.blueprint = blueprint
              } else {
                delete raw.blueprint
              }
              await Storage.write(notePath, raw)
              changed++
              rebuiltIndex = true
            }
          } catch (err) {
            log.warn("failed to remove note blueprint status", { scopeID: sid, noteID, error: String(err) })
          }

          done++
          if (done % 10 === 0 || done === totalNotes) {
            progress(done, totalNotes)
          }
        }

        if (rebuiltIndex) {
          await Storage.remove(StoragePath.note(s, "_index")).catch(() => {})
        }
      }
      log.info("blueprint status removal complete", { totalNotes, changed, scopes: scopeIDs.length })
    },
  },
  {
    id: "20260624-note-rebuild-expanded-preview-html",
    description: "Rebuild note metadata indices with expanded preview HTML",
    domain: "note",
    dependsOn: ["20260624-note-remove-blueprint-status"],
    async up(progress) {
      const scopeIDs = await Storage.scan(["notes"])
      let done = 0
      for (const sid of scopeIDs) {
        const s = Identifier.asScopeID(sid)
        await Storage.remove(StoragePath.note(s, "_index")).catch(() => {})
        done++
        progress(done, scopeIDs.length)
      }
      log.info("expanded preview metadata index rebuild scheduled", { scopes: scopeIDs.length })
    },
  },
  {
    id: "20260624-note-rebuild-rich-preview-html",
    description: "Rebuild note metadata indices with rich preview HTML",
    domain: "note",
    dependsOn: ["20260624-note-rebuild-expanded-preview-html"],
    async up(progress) {
      const scopeIDs = await Storage.scan(["notes"])
      let done = 0
      for (const sid of scopeIDs) {
        const s = Identifier.asScopeID(sid)
        await Storage.remove(StoragePath.note(s, "_index")).catch(() => {})
        done++
        progress(done, scopeIDs.length)
      }
      log.info("rich preview metadata index rebuild scheduled", { scopes: scopeIDs.length })
    },
  },
  {
    id: "20260626-note-add-block-ids",
    description: "Add stable blockId attributes to editable note document blocks",
    domain: "note",
    dependsOn: ["20260624-note-rebuild-rich-preview-html"],
    async up(progress) {
      const scopeIDs = await Storage.scan(["notes"])
      let totalNotes = 0
      for (const sid of scopeIDs) {
        const s = Identifier.asScopeID(sid)
        const ids = await Storage.scan(StoragePath.notesRoot(s))
        totalNotes += ids.filter((id) => !id.startsWith("_")).length
      }

      let done = 0
      let changed = 0
      for (const sid of scopeIDs) {
        const s = Identifier.asScopeID(sid)
        const ids = await Storage.scan(StoragePath.notesRoot(s))
        const noteIDs = ids.filter((id) => !id.startsWith("_"))
        let rebuiltIndex = false

        for (const noteID of noteIDs) {
          const notePath = StoragePath.note(s, noteID)
          try {
            const raw = await Storage.read<Record<string, unknown>>(notePath)
            const before = NoteDocument.hash(raw.content)
            raw.content = NoteDocument.normalize(raw.content)
            const after = NoteDocument.hash(raw.content)
            if (before !== after) {
              await Storage.write(notePath, raw)
              changed++
              rebuiltIndex = true
            }
          } catch (err) {
            log.warn("failed to add note block ids", { scopeID: sid, noteID, error: String(err) })
          }

          done++
          if (done % 10 === 0 || done === totalNotes) {
            progress(done, totalNotes)
          }
        }

        if (rebuiltIndex) {
          await Storage.remove(StoragePath.note(s, "_index")).catch(() => {})
        }
      }
      log.info("note block id migration complete", { totalNotes, changed, scopes: scopeIDs.length })
    },
  },
]

MigrationRegistry.register("note", migrations)
