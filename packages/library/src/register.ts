import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { SessionModePolicy } from "@ericsanchezok/synergy-harness/session/tool-mode-policy"
import { registerConfig } from "./config-schema"
import { registerLibraryMigrations } from "./migration"
import { registerLibraryAgents } from "./agents"
import { registerLibraryTools } from "./tools"
import { registerLibrarySessionRecall } from "./session-recall"
import { registerScopeLibraryStore } from "./scope-migration-store"
import { Chronicler } from "./chronicler"
import { Embedding } from "./vector/embedding"
import { closeDB } from "./database"

const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function registerLibrary() {
  const instanceState = runtimeState()

  if (instanceState.registered) return
  RuntimeContext.assertCompositionOpen("Library")
  registerConfig()
  registerLibraryMigrations()
  registerLibraryAgents()
  registerLibraryTools()
  registerLibrarySessionRecall()
  registerScopeLibraryStore()
  Chronicler.register()
  SessionModePolicy.register({
    id: "library",
    forcedGroups: (session) => (session?.interaction?.source === "chronicler" ? ["memory"] : []),
  })
  instanceState.registered = true
}

export async function disposeLibrary() {
  try {
    await Embedding.dispose()
  } finally {
    closeDB()
  }
}
