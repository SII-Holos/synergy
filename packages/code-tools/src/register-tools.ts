import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { ParseCodeTool } from "./parse-code"
import { AstGrepTool } from "./ast-grep/index"
import { registerAgentPermissions } from "./agent-permissions"

export function registerCodingTools() {
  registerAgentPermissions()
  ToolRegistry.registerToolProvider("code-tools", () => {
    const tools = [ParseCodeTool, AstGrepTool]
    return tools
  })
}
