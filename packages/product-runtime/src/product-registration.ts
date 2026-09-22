import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { registerSessionMigrations } from "@ericsanchezok/synergy-workflows/session-migration"
import { registerHolosRuntime } from "@ericsanchezok/synergy-connections/holos/runtime"
import { registerManagedProjectGuard } from "@ericsanchezok/synergy-connections/channel/managed-project-ownership"
import { registerWorkflowSessions } from "@ericsanchezok/synergy-workflows/session/register"
import { readGithubWatchPolicy, readBossAccounts } from "@ericsanchezok/synergy-connections/workflow-settings"
import { GithubWatchPolicy } from "@ericsanchezok/synergy-workflows/agenda/github-watch-policy"
import { BossRuntime } from "@ericsanchezok/synergy-workflows/boss/boss-runtime"
import { registerAgentWorkerEntrypoint } from "@ericsanchezok/synergy-harness/session/agent-turn/process-host"
import { registerLibrary } from "@ericsanchezok/synergy-library/register"
import { registerNote } from "@ericsanchezok/synergy-note/register"
import {
  registerPluginLightLoopAdapter,
  registerPluginBlueprintAdapter,
} from "@ericsanchezok/synergy-plugin-host/plugin/host-services"
import { lightLoopPluginAdapter } from "@ericsanchezok/synergy-workflows/light-loop/plugin-adapter"
import {
  cancelBlueprint,
  getBlueprint,
  startBlueprint,
} from "@ericsanchezok/synergy-workflows/blueprint/plugin-adapter"
import { registerPluginMcpServices } from "@ericsanchezok/synergy-plugin-host/plugin/mcp"
import { McpSupervisor } from "@ericsanchezok/synergy-agent-integrations/mcp/supervisor"
import { registerProductConfiguration } from "./configuration"
import { registerLocalRuntime } from "@ericsanchezok/synergy-runtime-local/register"
import { registerMediaTools } from "@ericsanchezok/synergy-media/register-tools"
import { registerDocumentExtraction } from "@ericsanchezok/synergy-media/register-documents"
import { registerCodingTools } from "@ericsanchezok/synergy-agent-integrations/register-tools"
import { registerConnectionsAgents } from "@ericsanchezok/synergy-connections/agents"
import { registerMediaAgents } from "@ericsanchezok/synergy-media/agents"
import { registerWorkbenchAgents } from "@ericsanchezok/synergy-workbench/agents"
import { registerWorkflowsAgents } from "@ericsanchezok/synergy-workflows/agents"
import { registerAgendaMigrations } from "@ericsanchezok/synergy-workflows/agenda/migration"
import { registerBlueprintMigrations } from "@ericsanchezok/synergy-workflows/blueprint/migration"
import { registerHolosMigrations } from "@ericsanchezok/synergy-connections/holos/migration"
import { registerLatticeMigrations } from "@ericsanchezok/synergy-workflows/lattice/migration"
import { registerPluginMigrations } from "@ericsanchezok/synergy-plugin-host/plugin/migration"

import { RuntimeReload } from "./runtime/reload"
import { RuntimeReloadExecutor } from "@ericsanchezok/synergy-harness/config/reload-executor"

import { registerBossDomain } from "@ericsanchezok/synergy-workflows/boss/register"
import { registerLightLoopDomain } from "@ericsanchezok/synergy-workflows/light-loop/register"
import { registerBlueprintDomain } from "@ericsanchezok/synergy-workflows/blueprint/register"
import { registerLatticeDomain } from "@ericsanchezok/synergy-workflows/lattice/register"
import { registerAgendaTools } from "@ericsanchezok/synergy-workflows/agenda/tools"
import { registerEmailTools } from "@ericsanchezok/synergy-connections/email/tools"
import { registerChannelTools } from "@ericsanchezok/synergy-connections/channel/tools"
import { registerComputerTools } from "@ericsanchezok/synergy-computer-runtime/tools"
import { registerBrowser } from "@ericsanchezok/synergy-browser-runtime/register"
import { registerProjectTools } from "@ericsanchezok/synergy-workbench/project/tools"
import { registerLspTools } from "@ericsanchezok/synergy-agent-integrations/lsp/tools"
import { registerSynergyLinkTools } from "@ericsanchezok/synergy-agent-integrations/synergy-link/tools"
import { registerPluginSkillSource } from "@ericsanchezok/synergy-plugin-host/plugin/skill-source"
import { registerPluginToolContext } from "@ericsanchezok/synergy-plugin-host/plugin/tool-context"
import { registerMcpCommandSource } from "@ericsanchezok/synergy-agent-integrations/mcp/instruction-source"
import { registerMcpToolSource } from "@ericsanchezok/synergy-agent-integrations/mcp/tool-source"
import { setTerminalHookDeliverer } from "@ericsanchezok/synergy-workflows/light-loop/runtime"
import { setBlueprintAgendaAssertClear } from "@ericsanchezok/synergy-workflows/blueprint/tools/blueprint-loop-stop"
import { setLightLoopAgendaAssertClear } from "@ericsanchezok/synergy-workflows/light-loop/tools/loop-stop"
import { AgendaSessionWakeup } from "@ericsanchezok/synergy-workflows/agenda/session-wakeup"
import { registerPluginStartup } from "@ericsanchezok/synergy-plugin-host/plugin/startup"
import { registerLatticeStartup } from "@ericsanchezok/synergy-workflows/lattice/startup"
import { registerLspStartup } from "@ericsanchezok/synergy-agent-integrations/lsp/startup"
import { registerProjectStartup } from "@ericsanchezok/synergy-workbench/project/startup"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { registerBlueprintSessionState } from "@ericsanchezok/synergy-workflows/blueprint/session-state"
import { registerProjectSessionHealth } from "@ericsanchezok/synergy-workbench/project/session-health"
import { registerPluginSessionHooks } from "@ericsanchezok/synergy-plugin-host/plugin/session-hooks"
import { registerExternalAgentSessionBridge } from "@ericsanchezok/synergy-agent-integrations/external-agent/session-bridge"
import { registerAgendaSessionSignals } from "@ericsanchezok/synergy-workflows/agenda/session-signals"
import { registerMcpSessionInput } from "@ericsanchezok/synergy-agent-integrations/mcp/session-input"
import { registerLspSessionInput } from "@ericsanchezok/synergy-agent-integrations/lsp/session-input"
import { registerChannelSessionProjects } from "@ericsanchezok/synergy-connections/channel/session-projects"
import { registerSuperPlanSessionEnv } from "@ericsanchezok/synergy-workflows/superplan/session-env"
import { registerAgentPluginSource } from "@ericsanchezok/synergy-plugin-host/plugin/agent-source"
import { registerAgentExternalSource } from "@ericsanchezok/synergy-agent-integrations/external-agent/agent-source"
import { registerPermissionPluginSource } from "@ericsanchezok/synergy-plugin-host/plugin/permission-source"
import { registerProviderPluginAuth } from "@ericsanchezok/synergy-plugin-host/plugin/provider-auth-source"
import { registerToolPluginSource } from "@ericsanchezok/synergy-plugin-host/plugin/tool-source"
import { registerLspToolSource } from "@ericsanchezok/synergy-agent-integrations/lsp/tool-source"
import { registerWorkspaceFileSymbolSource } from "@ericsanchezok/synergy-agent-integrations/lsp/workspace-symbol-source"
import { registerLspConfigCatalog } from "@ericsanchezok/synergy-agent-integrations/lsp/config-catalog"
import { registerToolLinkTargetSource } from "@ericsanchezok/synergy-agent-integrations/synergy-link/tool-target-source"

const registration = RuntimeContext.state(() => ({ complete: false }))
export function registerProductRuntime() {
  if (registration().complete) return
  registerProductConfiguration()
  registerSessionMigrations()
  registerAgendaMigrations()
  registerBlueprintMigrations()
  registerHolosMigrations()
  registerLatticeMigrations()
  registerPluginMigrations()
  Plugin.registerLifecycle()
  registerHolosRuntime()
  registerManagedProjectGuard()

  registerLocalRuntime()
  registerWorkflowSessions()
  GithubWatchPolicy.register(readGithubWatchPolicy)
  BossRuntime.registerAccountSource(readBossAccounts)
  registerLibrary()
  registerNote()
  registerMediaTools()
  registerDocumentExtraction()
  registerCodingTools()
  registerConnectionsAgents()
  registerMediaAgents()
  registerWorkbenchAgents()
  registerWorkflowsAgents()
  registerBossDomain()
  registerLightLoopDomain()
  registerBlueprintDomain()
  registerLatticeDomain()
  registerAgendaTools()
  registerEmailTools()
  registerChannelTools()
  registerBrowser()
  registerComputerTools()
  registerProjectTools()
  registerLspTools()
  registerSynergyLinkTools()
  registerPluginSkillSource()
  registerPluginToolContext()
  registerMcpCommandSource()
  registerMcpToolSource()
  registerPluginStartup()
  registerLatticeStartup()
  registerLspStartup()
  registerProjectStartup()
  registerBlueprintSessionState()
  registerProjectSessionHealth()
  registerPluginSessionHooks()
  registerExternalAgentSessionBridge()
  registerAgendaSessionSignals()
  registerMcpSessionInput()
  registerLspSessionInput()
  registerChannelSessionProjects()
  registerSuperPlanSessionEnv()
  registerAgentPluginSource()
  registerAgentExternalSource()
  registerPermissionPluginSource()
  registerProviderPluginAuth()
  registerToolPluginSource()
  registerLspToolSource()
  registerWorkspaceFileSymbolSource()
  registerLspConfigCatalog()
  registerToolLinkTargetSource()

  // L4 assembly: the light-loop domain consumes plugin hook delivery through an
  // injected function so product domains stay acyclic (no light-loop→plugin
  // import; plugin→light-loop host-services remains the allowed direction).
  setTerminalHookDeliverer((pluginId, pluginGeneration, pointName, input) =>
    Plugin.deliverHookForPlugin(pluginId, pluginGeneration, pointName, input),
  )

  // L4 assembly: the blueprint domain's stop tool consumes the agenda wakeup
  // guard through an injected function (agenda dynamically imports blueprint
  // for wakeup instructions; a static reverse edge would close a cycle).
  setBlueprintAgendaAssertClear((input) => AgendaSessionWakeup.assertClear(input))

  // L4 assembly: the light-loop domain's stop tool consumes the agenda wakeup
  // guard through the same injected-function pattern as blueprint above.
  setLightLoopAgendaAssertClear((input) => AgendaSessionWakeup.assertClear(input))

  // L4 assembly: L1 write paths reach the runtime reload orchestrator through
  // the executor port in config/reload-executor (no L1 import of runtime/).
  RuntimeReloadExecutor.setExecutor((input, options) => RuntimeReload.reload(input, options))
  RuntimeReloadExecutor.setGlobalExecutor((input, options) => RuntimeReload.reloadGlobal(input, options))

  registerPluginLightLoopAdapter(lightLoopPluginAdapter)
  registerPluginBlueprintAdapter({ start: startBlueprint, get: getBlueprint, cancel: cancelBlueprint })
  registerPluginMcpServices(McpSupervisor())

  registerAgentWorkerEntrypoint(new URL("./agent-worker.ts", import.meta.url))

  registration().complete = true
}
