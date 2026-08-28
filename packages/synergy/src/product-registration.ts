/**
 * L4 product manifest: the single static list through which built-in product
 * domains attach to the harness core. Every real entry point loads this module
 * (main.ts for CLI commands, server/runtime.ts for the server and daemon
 * process), so product registrations are present before any core registry is
 * consumed.
 *
 * Current scope: product-domain migrations (S1), boss domain (S2), light-loop
 * domain (S3), blueprint domain (S4), lattice domain (S5), instruction
 * domains (S7: skill, command, mcp), tool partition (S8: agenda, note,
 * email, channel), tool partition continuation (S9: browser, cortex,
 * project, question, library, lsp, synergy-link), session source
 * inversions (S9d: agent, config, enforcement, permission, provider,
 * scope, tool, workspace-file), final structural slice (S10a: runtime
 * reload executor port, L1 reload schema/path, L0 lock infrastructure).
 */
import "./agenda/migration"
import "./blueprint/migration"
import "./browser/migration"
import "./holos/migration"
import "./lattice/migration"
import "./library/migration"
import "./note/migration"
import "./plugin/migration"
import "./library/chronicler"

import { RuntimeReload } from "./runtime/reload"
import { RuntimeReloadExecutor } from "./config/reload-executor"

import { registerBossDomain } from "./boss/register"
import { registerLightLoopDomain } from "./light-loop/register"
import { registerBlueprintDomain } from "./blueprint/register"
import { registerLatticeDomain } from "./lattice/register"
import { registerSkillDomain } from "./skill/register"
import { registerCommandDomain } from "./command/register"
import { registerAgendaTools } from "./agenda/tools"
import { registerNoteTools } from "./note/tools"
import { registerEmailTools } from "./email/tools"
import { registerChannelTools } from "./channel/tools"
import { registerBrowserTools } from "./browser/tools"
import { registerCortexTools } from "./cortex/tools"
import { registerProjectTools } from "./project/tools"
import { registerQuestionTools } from "./question/tools"
import { registerLibraryTools } from "./library/tools"
import { registerLspTools } from "./lsp/tools"
import { registerSynergyLinkTools } from "./synergy-link/tools"
import { registerPluginSkillSource } from "./plugin/skill-source"
import { registerPluginToolContext } from "./plugin/tool-context"
import { registerMcpCommandSource } from "./mcp/instruction-source"
import { registerMcpToolSource } from "./mcp/tool-source"
import { registerBlueprintToolAccess } from "./blueprint/tool-access"
import { setTerminalHookDeliverer } from "./light-loop/runtime"
import { setBlueprintAgendaAssertClear } from "./blueprint/tools/blueprint-loop-stop"
import { setLightLoopAgendaAssertClear } from "./light-loop/tools/loop-stop"
import { AgendaSessionWakeup } from "./agenda/session-wakeup"
import { registerPluginStartup } from "./plugin/startup"
import { registerLatticeStartup } from "./lattice/startup"
import { registerLspStartup } from "./lsp/startup"
import { registerProjectStartup } from "./project/startup"
import { registerCommandStartup } from "./command/startup"
import { Plugin } from "./plugin"
import { registerBlueprintSessionState } from "./blueprint/session-state"
import { registerProjectSessionHealth } from "./project/session-health"
import { registerLibrarySessionRecall } from "./library/session-recall"
import { registerNoteSessionAccess } from "./note/session-access"
import { registerPluginSessionHooks } from "./plugin/session-hooks"
import { registerCommandSessionRuntime } from "./command/session-runtime"
import { registerCortexSessionRuntime } from "./cortex/session-runtime"
import { registerExternalAgentSessionBridge } from "./external-agent/session-bridge"
import { registerAgendaSessionSignals } from "./agenda/session-signals"
import { registerQuestionSessionErrors } from "./question/session-errors"
import { registerMcpSessionInput } from "./mcp/session-input"
import { registerLspSessionInput } from "./lsp/session-input"
import { registerChannelSessionProjects } from "./channel/session-projects"
import { registerSuperPlanSessionEnv } from "./superplan/session-env"
import { registerAgentPluginSource } from "./plugin/agent-source"
import { registerAgentExternalSource } from "./external-agent/agent-source"
import { registerPermissionPluginSource } from "./plugin/permission-source"
import { registerProviderPluginAuth } from "./plugin/provider-auth-source"
import { registerScopeLibraryStore } from "./library/scope-migration-store"
import { registerToolPluginSource } from "./plugin/tool-source"
import { registerLspToolSource } from "./lsp/tool-source"
import { registerWorkspaceFileSymbolSource } from "./lsp/workspace-symbol-source"
import { registerLspConfigCatalog } from "./lsp/config-catalog"
import { registerToolLinkTargetSource } from "./synergy-link/tool-target-source"
import { registerNoteVirtualFileSource } from "./note/virtual-file-source"

registerBossDomain()
registerLightLoopDomain()
registerBlueprintDomain()
registerLatticeDomain()
registerSkillDomain()
registerCommandDomain()
registerAgendaTools()
registerNoteTools()
registerEmailTools()
registerChannelTools()
registerBrowserTools()
registerCortexTools()
registerProjectTools()
registerQuestionTools()
registerLibraryTools()
registerLspTools()
registerSynergyLinkTools()
registerPluginSkillSource()
registerPluginToolContext()
registerMcpCommandSource()
registerMcpToolSource()
registerBlueprintToolAccess()
registerPluginStartup()
registerLatticeStartup()
registerLspStartup()
registerProjectStartup()
registerCommandStartup()
registerBlueprintSessionState()
registerProjectSessionHealth()
registerLibrarySessionRecall()
registerNoteSessionAccess()
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
registerScopeLibraryStore()
registerToolPluginSource()
registerLspToolSource()
registerWorkspaceFileSymbolSource()
registerLspConfigCatalog()
registerToolLinkTargetSource()
registerNoteVirtualFileSource()

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
