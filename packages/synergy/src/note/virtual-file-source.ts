import { ToolNoteSource } from "../tool/note-source"
import { NoteMarkdown, NoteStore } from "./index"

/**
 * S9d source inversion: the L1 bash virtual-file materializer reads note
 * content through this registered source instead of importing the note
 * product domain. Loaded through src/product-registration.ts.
 */
export function registerNoteVirtualFileSource() {
  ToolNoteSource.register({
    noteExtension: ".md",
    readNoteMarkdown: async (scopeID, noteID) => {
      const note = await NoteStore.getAny(scopeID, noteID)
      return NoteMarkdown.toMarkdown(note.content)
    },
  })
}
