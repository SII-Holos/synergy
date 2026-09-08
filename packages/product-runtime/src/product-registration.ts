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
import "./configuration"
import { registerLocalRuntime } from "@ericsanchezok/synergy-runtime-local/register"
import { registerMediaTools } from "@ericsanchezok/synergy-media/register-tools"
import { registerDocumentExtraction } from "@ericsanchezok/synergy-media/register-documents"
import { registerCodingTools } from "@ericsanchezok/synergy-agent-integrations/register-tools"
import { registerConnectionsAgents } from "@ericsanchezok/synergy-connections/agents"
import { registerMediaAgents } from "@ericsanchezok/synergy-media/agents"
import { registerWorkbenchAgents } from "@ericsanchezok/synergy-workbench/agents"
import { registerWorkflowsAgents } from "@ericsanchezok/synergy-workflows/agents"
import "@ericsanchezok/synergy-workflows/agenda/migration"
import "@ericsanchezok/synergy-workflows/blueprint/migration"
import "@ericsanchezok/synergy-connections/holos/migration"
import "@ericsanchezok/synergy-workflows/lattice/migration"
import "@ericsanchezok/synergy-plugin-host/plugin/migration"

import { RuntimeReload } from "./runtime/reload"
import { RuntimeReloadExecutor } from "@ericsanchezok/synergy-harness/config/reload-executor"

import { registerBossDomain } from "@ericsanchezok/synergy-workflows/boss/register"
import { registerLightLoopDomain } from "@ericsanchezok/synergy-workflows/light-loop/register"
import { registerBlueprintDomain } from "@ericsanchezok/synergy-workflows/blueprint/register"
import { registerLatticeDomain } from "@ericsanchezok/synergy-workflows/lattice/register"
import { registerSkillDomain } from "@ericsanchezok/synergy-runtime-local/skill/register"
import { registerCommandDomain } from "@ericsanchezok/synergy-runtime-local/command/register"
import { registerAgendaTools } from "@ericsanchezok/synergy-workflows/agenda/tools"
import { registerEmailTools } from "@ericsanchezok/synergy-connections/email/tools"
import { registerChannelTools } from "@ericsanchezok/synergy-connections/channel/tools"
import { registerComputerTools } from "@ericsanchezok/synergy-computer-runtime/tools"
import { registerBrowser } from "@ericsanchezok/synergy-browser-runtime/register"
import { registerCortexTools } from "@ericsanchezok/synergy-harness/cortex/tools"
import { registerProjectTools } from "@ericsanchezok/synergy-workbench/project/tools"
import { registerQuestionTools } from "@ericsanchezok/synergy-runtime-local/question/tools"
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
import { registerCommandStartup } from "@ericsanchezok/synergy-runtime-local/command/startup"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { registerBlueprintSessionState } from "@ericsanchezok/synergy-workflows/blueprint/session-state"
import { registerProjectSessionHealth } from "@ericsanchezok/synergy-workbench/project/session-health"
import { registerPluginSessionHooks } from "@ericsanchezok/synergy-plugin-host/plugin/session-hooks"
import { registerCommandSessionRuntime } from "@ericsanchezok/synergy-runtime-local/command/session-runtime"
import { registerCortexSessionRuntime } from "@ericsanchezok/synergy-harness/cortex/session-runtime"
import { registerExternalAgentSessionBridge } from "@ericsanchezok/synergy-agent-integrations/external-agent/session-bridge"
import { registerAgendaSessionSignals } from "@ericsanchezok/synergy-workflows/agenda/session-signals"
import { registerQuestionSessionErrors } from "@ericsanchezok/synergy-runtime-local/question/session-errors"
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
registerSkillDomain()
registerCommandDomain()
registerAgendaTools()
registerEmailTools()
registerChannelTools()
registerBrowser()
registerComputerTools()
registerCortexTools()
registerProjectTools()
registerQuestionTools()
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
registerCommandStartup()
registerBlueprintSessionState()
registerProjectSessionHealth()
registerPluginSessionHooks()
registerCommandSessionRuntime()
registerCortexSessionRuntime()
registerExternalAgentSessionBridge()
registerAgendaSessionSignals()
registerQuestionSessionErrors()
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
registerPluginMcpServices(McpSupervisor)

registerAgentWorkerEntrypoint(new URL("./agent-worker.ts", import.meta.url))
