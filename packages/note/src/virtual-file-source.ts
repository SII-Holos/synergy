import { BashVirtualPath } from "@ericsanchezok/synergy-harness/tool/virtual-path"
import { NoteMarkdown, NoteStore } from "."

export function registerNoteVirtualFileSource() {
  BashVirtualPath.register("note", {
    extension: ".md",
    match: (value) => /^\/synergy\/note\/(nte_[A-Za-z0-9_-]+)$/.exec(value)?.[1],
    read: async (scopeID, noteID) => {
      const note = await NoteStore.getAny(scopeID, noteID)
      return NoteMarkdown.toMarkdown(note.content)
    },
  })
}
