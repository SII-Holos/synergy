import { InstructionEngine } from "../instruction/engine"

export namespace SkillRenderer {
  const supportedHints = ["$ARGUMENTS", "$ARGUMENTS[N]", "$N (one-based)"]

  export function hints() {
    return [...supportedHints]
  }

  export function render(input: { template: string; arguments: string }) {
    return InstructionEngine.render(input, { appendArgsWhenNoPlaceholder: true })
  }
}
