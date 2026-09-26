import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { migrations } from "./migration"
import { registerBrowserTools } from "./tools"
import { registerBrowserCommands } from "./command-service"
import { BrowserRuntime } from "./runtime"
import { SessionWorkspaceRuntime } from "@ericsanchezok/synergy-harness/session/workspace-runtime"

const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function registerBrowser() {
  const instanceState = runtimeState()

  if (instanceState.registered) return
  MigrationRegistry.register("browser", migrations)
  registerBrowserTools()
  registerBrowserCommands()
  SessionWorkspaceRuntime.registerTransition("browser", (session) =>
    BrowserRuntime.invalidateSession({
      mode: "session",
      scopeID: session.scope.id,
      sessionID: session.id,
      directory: session.workspace?.path ?? null,
    }),
  )
  instanceState.registered = true
}

export async function disposeBrowser() {
  await BrowserRuntime.stop()
}
