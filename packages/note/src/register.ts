import { registerNoteMigrations } from "./migration"
import { registerNoteTools } from "./tools"
import { registerNoteSessionAccess } from "./session-access"
import { registerNoteVirtualFileSource } from "./virtual-file-source"

let registered = false

export function registerNote() {
  if (registered) return
  registered = true
  registerNoteMigrations()
  registerNoteTools()
  registerNoteSessionAccess()
  registerNoteVirtualFileSource()
}
