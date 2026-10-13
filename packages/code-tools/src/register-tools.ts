import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { ParseCodeTool } from "./parse-code"
import { AstGrepTool } from "./ast-grep/index"
import { registerCodePrompts } from "./agent-prompts"
import { registerAgentPermissions } from "./agent-permissions"

export function registerCodingTools() {
  registerAgentPermissions()
  registerCodePrompts()
  ToolRegistry.registerToolProvider("code-tools", () => {
    const tools = [ParseCodeTool, AstGrepTool]
    return tools
  })
}
