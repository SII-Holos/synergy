import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { BUILTIN_SKILLS } from "./builtin"

/** Hosts select deployed skill sources during composition; defaults preserve the full local product. */
export namespace SkillSelection {
  const state = RuntimeContext.state(() => ({
    selection: undefined as { builtins: Set<string>; filesystem: boolean } | undefined,
    initialized: false,
  }))
  export function select(input: { builtins: readonly string[]; filesystem: boolean }) {
    RuntimeContext.assertCompositionOpen("skill selection")
    const current = state()
    if (current.selection || current.initialized) throw new Error("Select skills before catalog initialization")
    if (input.builtins.some((name) => !BUILTIN_SKILLS.some((skill) => skill.name === name)))
      throw new Error("Unknown builtin skill")
    current.selection = { builtins: new Set(input.builtins), filesystem: input.filesystem }
  }
  export function builtins() {
    const current = state()
    current.initialized = true
    return BUILTIN_SKILLS.filter((skill) => !current.selection || current.selection.builtins.has(skill.name))
  }
  export function filesystem() {
    const current = state()
    current.initialized = true
    return current.selection?.filesystem ?? true
  }
}
