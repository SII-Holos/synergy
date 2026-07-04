import z from "zod"
import { Tool } from "./tool"
import { NoteStore } from "../note"
import { ScopeContext } from "../scope/context"
import DESCRIPTION from "./note-archive.txt"

const parameters = z.object({
  ids: z
    .array(z.string())
    .min(1)
    .max(100)
    .describe("IDs of notes to archive. Notes must be archived before they can be deleted."),
  unarchive: z.boolean().default(false).describe("Set to true to restore archived notes back to active state."),
})

export const NoteArchiveTool = Tool.define("note_archive", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const scopeID = ScopeContext.current.scope.id

    if (params.unarchive) {
      const notes = await NoteStore.unarchive(scopeID, params.ids)
      return {
        title: `Unarchived ${notes.length} note${notes.length === 1 ? "" : "s"}`,
        output: `Restored ${notes.length} note${notes.length === 1 ? "" : "s"} from archive:\n${notes
          .map((n) => `- [${n.id}] "${n.title}"`)
          .join("\n")}`,
        metadata: { count: notes.length, ids: params.ids, action: "unarchive" } as Record<string, any>,
      }
    }

    const notes = await NoteStore.archive(scopeID, params.ids)
    return {
      title: `Archived ${notes.length} note${notes.length === 1 ? "" : "s"}`,
      output: `Archived ${notes.length} note${notes.length === 1 ? "" : "s"}. They can be restored with note_archive(ids: [...], unarchive: true) or permanently deleted from the Archived view in the Notes UI:\n${notes
        .map((n) => `- [${n.id}] "${n.title}"`)
        .join("\n")}`,
      metadata: { count: notes.length, ids: params.ids, action: "archive" } as Record<string, any>,
    }
  },
})
