import { RuntimeContext } from "../lifecycle/context"
import type { Scope } from "../scope"
import type { Workspace } from "./types"

export namespace InstructionSource {
  export interface Source {
    load(input: Readonly<{ scope: Scope; workspace: Workspace | null }>): Promise<string[]>
  }
  const state = RuntimeContext.state(() => ({ source: undefined as Source | undefined }))

  export function register(source: Source) {
    RuntimeContext.assertCompositionOpen("instruction source")
    if (state().source) throw new Error("Instruction source is already registered")
    state().source = source
  }

  export function get() {
    return state().source
  }
}
