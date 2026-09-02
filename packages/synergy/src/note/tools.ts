import { ToolRegistry } from "../tool/registry"
import { NoteArchiveTool } from "./tools/note-archive"
import { NoteListTool } from "./tools/note-list"
import { NoteReadTool } from "./tools/note-read"
import { NoteSearchTool } from "./tools/note-search"
import { NoteWriteTool } from "./tools/note-write"
import { NoteEditTool } from "./tools/note-edit"
import { NoteDeleteTool } from "./tools/note-delete"

/**
 * Note domain tool registration. Loaded through src/product-registration.ts.
 */
let registered = false

export function registerNoteTools(): void {
  if (registered) return
  registered = true

  ToolRegistry.registerToolProvider("note", () => [
    NoteArchiveTool,
    NoteListTool,
    NoteReadTool,
    NoteSearchTool,
    NoteWriteTool,
    NoteEditTool,
    NoteDeleteTool,
  ])
}
