import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { channelBlueprint } from "@ericsanchezok/synergy-channel-blueprint/component"
import { channelLightLoop } from "@ericsanchezok/synergy-channel-light-loop/component"
import { channelLattice } from "@ericsanchezok/synergy-channel-lattice/component"
import { githubAgenda } from "@ericsanchezok/synergy-github-agenda/component"
import { bossFeishu } from "@ericsanchezok/synergy-boss-feishu/component"
import { pluginLightLoop } from "@ericsanchezok/synergy-plugin-light-loop/component"
import { pluginBlueprint } from "@ericsanchezok/synergy-plugin-blueprint/component"
import { pluginAgenda } from "@ericsanchezok/synergy-plugin-agenda/component"
import { agendaLightLoop } from "@ericsanchezok/synergy-agenda-light-loop/component"
import { agendaBlueprint } from "@ericsanchezok/synergy-agenda-blueprint/component"
import { acp } from "@ericsanchezok/synergy-acp/component"
import { codeTools } from "@ericsanchezok/synergy-code-tools/component"
import { computer } from "@ericsanchezok/synergy-computer-runtime/component"
import { connectionComponents } from "@ericsanchezok/synergy-connections/component"
import { externalAgents } from "@ericsanchezok/synergy-external-agents/component"
import { formatter } from "@ericsanchezok/synergy-formatter/component"
import { digitalTwin } from "@ericsanchezok/synergy-digital-twin/component"
import { library } from "@ericsanchezok/synergy-library/component"
import { lsp } from "@ericsanchezok/synergy-lsp/component"
import { mcp } from "@ericsanchezok/synergy-mcp/component"
import { media } from "@ericsanchezok/synergy-media/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { workbench } from "@ericsanchezok/synergy-workbench/component"
import { workflowComponents } from "@ericsanchezok/synergy-workflows/component"
import { pluginKit } from "@ericsanchezok/synergy-plugin-kit/component"
import { dataManagement } from "./component"
import { server } from "@ericsanchezok/synergy-server/component"

export function fullComponents(): RuntimeComponent[] {
  return [
    acp(),
    codeTools(),
    computer(),
    ...connectionComponents(),
    externalAgents(),
    formatter(),
    library(),
    digitalTwin(),
    lsp(),
    mcp(),
    media(),
    note(),
    workbench(),
    ...workflowComponents(),
    channelBlueprint(),
    channelLightLoop(),
    channelLattice(),
    githubAgenda(),
    bossFeishu(),
    pluginLightLoop(),
    pluginBlueprint(),
    pluginAgenda(),
    agendaLightLoop(),
    agendaBlueprint(),
    pluginKit(),
    dataManagement(),
    server(),
  ]
}

export async function desktopComponents() {
  const { browser } = await import("@ericsanchezok/synergy-browser-runtime/component")
  return [...fullComponents(), browser()]
}
