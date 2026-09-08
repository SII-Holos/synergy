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

let registered = false

export function registerLibrary() {
  if (registered) return
  registered = true
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
}

export async function disposeLibrary() {
  try {
    await Embedding.dispose()
  } finally {
    closeDB()
  }
}
