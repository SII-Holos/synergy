import { SessionNoteAccess } from "../session/note-access"
import { NoteStore } from "./store"

/**
 * S9c source inversion: the L1 session recovery pass reaches blueprint note
 * projections through the SessionNoteAccess registry instead of importing
 * the note product domain. Loaded through src/product-registration.ts.
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
    async setBlueprintActiveLoop(scopeID, noteID, activeLoopID) {
      await NoteStore.updateAny(scopeID, noteID, { blueprint: { activeLoopID } })
    },
  })
}
