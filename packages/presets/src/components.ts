import { acp } from "@ericsanchezok/synergy-acp/component"
import { codeTools } from "@ericsanchezok/synergy-code-tools/component"
import { computer } from "@ericsanchezok/synergy-computer-runtime/component"
import { connections } from "@ericsanchezok/synergy-connections/component"
import { externalAgents } from "@ericsanchezok/synergy-external-agents/component"
import { formatter } from "@ericsanchezok/synergy-formatter/component"
import { library } from "@ericsanchezok/synergy-library/component"
import { lsp } from "@ericsanchezok/synergy-lsp/component"
import { mcp } from "@ericsanchezok/synergy-mcp/component"
import { media } from "@ericsanchezok/synergy-media/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { workbench } from "@ericsanchezok/synergy-workbench/component"
import { workflows } from "@ericsanchezok/synergy-workflows/component"
import { pluginKit } from "@ericsanchezok/synergy-plugin-kit/component"
import { dataManagement } from "./component"
import { server } from "@ericsanchezok/synergy-server/component"

export function fullComponents() {
  return [
    acp(),
    codeTools(),
    computer(),
    connections(),
    externalAgents(),
    formatter(),
    library(),
    lsp(),
    mcp(),
    media(),
    note(),
    workbench(),
    workflows(),
    pluginKit(),
    dataManagement(),
    server(),
  ]
}

export async function desktopComponents() {
  const { browser } = await import("@ericsanchezok/synergy-browser-runtime/component")
  return [...fullComponents(), browser()]
}
