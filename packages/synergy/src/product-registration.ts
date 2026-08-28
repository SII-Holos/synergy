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
 * project, question, library, lsp, synergy-link).
 */
import "./agenda/migration"
import "./blueprint/migration"
import "./browser/migration"
import "./holos/migration"
import "./lattice/migration"
import "./library/migration"
import "./note/migration"
import "./plugin/migration"

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
import { AgendaSessionWakeup } from "./agenda/session-wakeup"
import { registerPluginStartup } from "./plugin/startup"
import { registerLatticeStartup } from "./lattice/startup"
import { registerLspStartup } from "./lsp/startup"
import { registerProjectStartup } from "./project/startup"
import { registerCommandStartup } from "./command/startup"
import { Plugin } from "./plugin"

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
registerMcpCommandSource()
registerMcpToolSource()
registerBlueprintToolAccess()
registerPluginStartup()
registerLatticeStartup()
registerLspStartup()
registerProjectStartup()
registerCommandStartup()

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
