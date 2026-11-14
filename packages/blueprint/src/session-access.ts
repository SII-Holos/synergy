import { SessionNoteAccess } from "./session-contract"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

/**
 * S9c source inversion: the L1 session recovery pass reaches blueprint note
 * projections through the SessionNoteAccess registry instead of importing
 * the note product domain. Loaded through src/registration.ts.
 */
export function registerNoteSessionAccess() {
  SessionNoteAccess.register({
    async getBlueprintNote(scopeID, noteID) {
      const note = await NoteStore.getAny(scopeID, noteID).catch(() => undefined)
      if (!note || note.kind !== "blueprint") return undefined
      return { noteID: note.id, activeLoopID: note.blueprint?.activeLoopID }
    },
    async listBlueprintNotes(scopeID) {
      const notes = await NoteStore.list(scopeID, "all").catch(() => [])
      return notes
        .filter((note) => note.kind === "blueprint")
        .map((note) => ({ noteID: note.id, activeLoopID: note.blueprint?.activeLoopID }))
    },
    async hasBlueprintActiveLoop(scopeID, noteID, loopID) {
      try {
        return await NoteStore.inspectMetadataAny(
          scopeID,
          noteID,
          (note) => note.kind === "blueprint" && note.blueprint?.activeLoopID === loopID,
        )
      } catch (error) {
        if (error instanceof Storage.NotFoundError) return false
        throw error
      }
    },
    async setBlueprintActiveLoop(scopeID, noteID, activeLoopID, source, expectedActiveLoopID) {
      let changed = false
      try {
        await NoteStore.mutateMetadataAny(scopeID, noteID, (note) => {
          if (note.kind !== "blueprint") return false
          if (expectedActiveLoopID !== undefined && note.blueprint?.activeLoopID !== expectedActiveLoopID) return false
          note.blueprint ??= {}
          if (activeLoopID) {
            note.blueprint.activeLoopID = activeLoopID
            if (source) note.blueprint.activeLoopSource = source
            else delete note.blueprint.activeLoopSource
          } else {
            delete note.blueprint.activeLoopID
            delete note.blueprint.activeLoopSource
          }
          changed = true
        })
      } catch (error) {
        if (expectedActiveLoopID !== undefined && error instanceof Storage.NotFoundError) return false
        throw error
      }
      return changed
    },
  })
}
