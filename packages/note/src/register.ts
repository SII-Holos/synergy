import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { registerNoteMigrations } from "./migration"
import { registerNoteTools } from "./tools"
import { registerNoteVirtualFileSource } from "./virtual-file-source"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { NoteEvent } from "./event"
import { registerNoteAgentPermissions } from "./agent-permissions"
import { registerNotePrompts } from "./agent-prompts"

const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function registerNote() {
  const instanceState = runtimeState()

  if (instanceState.registered) return
  instanceState.registered = true
  BusEvent.register(...Object.values(NoteEvent))
  registerNoteAgentPermissions()
  registerNotePrompts()
  registerNoteMigrations()
  registerNoteTools()
  registerNoteVirtualFileSource()
}
