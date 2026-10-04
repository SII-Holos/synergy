import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { registerToolGroup } from "./tool-group-note"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { NoteArchiveTool } from "./tools/note-archive"
import { NoteListTool } from "./tools/note-list"
import { NoteReadTool } from "./tools/note-read"
import { NoteSearchTool } from "./tools/note-search"
import { NoteWriteTool } from "./tools/note-write"
import { NoteEditTool } from "./tools/note-edit"
import { NoteDeleteTool } from "./tools/note-delete"

/**
 * Note domain tool registration. Loaded through src/registration.ts.
 */
const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

/** Register owned history when a host supplies its own tool catalog. */
export function registerNoteToolInputHistory(): void {
  Tool.registerInputHistory("note", {
    note_write: {
      id: "noteId",
      title: "noteTitle",
      content: "noteContent",
      description: "blueprintDescription",
    },
    note_read: {
      ids: "noteIds",
    },
    note_edit: {
      id: "noteId",
    },
    note_delete: {
      id: "noteId",
    },
    note_archive: {
      ids: "noteIds",
    },
  })
}

export function registerNoteTools(): void {
  registerNoteToolInputHistory()
  const instanceState = runtimeState()

  registerToolGroup()
  if (instanceState.registered) return
  instanceState.registered = true

  ToolRegistry.registerToolProvider("note", noteTools)
}

/** Complete toolkit for hosts that own group metadata and registration. */
export function noteTools() {
  return [NoteArchiveTool, NoteListTool, NoteReadTool, NoteSearchTool, NoteWriteTool, NoteEditTool, NoteDeleteTool]
}
