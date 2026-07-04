import z from "zod"
import { Tool } from "./tool"
import { NoteStore, NoteError } from "../note"
import { ScopeContext } from "../scope/context"
import DESCRIPTION from "./note-delete.txt"

const parameters = z.object({
  id: z.string().describe("Note ID to permanently delete. The note must already be archived."),
})

export const NoteDeleteTool = Tool.define("note_delete", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const scopeID = ScopeContext.current.scope.id

    const note = await NoteStore.getAny(scopeID, params.id)

    if (!note.archived) {
      return {
        title: `Cannot delete active note`,
        output:
          `Note "${note.title}" [${note.id}] is still active and must be archived before it can be permanently deleted. ` +
          `Use note_archive({ ids: ["${params.id}"], action: "archive" }) first, then retry note_delete.`,
        metadata: { id: params.id, archived: false } as Record<string, any>,
      }
    }

    await NoteStore.removeAny(scopeID, params.id)

    return {
      title: `Deleted note`,
      output: `Permanently deleted note "${note.title}" [${note.id}].`,
      metadata: { id: params.id, title: note.title, archived: true } as Record<string, any>,
    }
  },
})
