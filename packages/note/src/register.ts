import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { registerNoteMigrations } from "./migration"
import { registerNoteTools } from "./tools"
import { registerNoteSessionAccess } from "./session-access"
import { registerNoteVirtualFileSource } from "./virtual-file-source"

const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function registerNote() {
  const instanceState = runtimeState()

  if (instanceState.registered) return
  instanceState.registered = true
  registerNoteMigrations()
  registerNoteTools()
  registerNoteSessionAccess()
  registerNoteVirtualFileSource()
}
