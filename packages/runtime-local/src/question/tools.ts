import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { Flag } from "@ericsanchezok/synergy-harness/flag/flag"
import { QuestionTool } from "./tools/question"

/**
 * Question domain tool registration. Loaded through src/product-registration.ts.
 * The tool is CLI-only; the gate is evaluated per provider drain.
 */
let registered = false

export function registerQuestionTools(): void {
  if (registered) return
  registered = true

  ToolRegistry.registerToolProvider("question", () => (Flag.SYNERGY_CLIENT === "cli" ? [QuestionTool] : []))
}
