import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { ParseCodeTool } from "./tools/parse-code"
import { AstGrepTool } from "./tools/ast-grep"

export function registerCodingTools() {
  ToolRegistry.registerToolProvider("agent-integrations", () => {
    const tools = [ParseCodeTool, AstGrepTool]
    return tools
  })
}
