import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import type { Agent } from "../agent/agent"
import type { Provider } from "../provider/provider"
import type { Session } from "../session"

export namespace ToolPolicySource {
  export interface SelectionInput {
    sessionID: string
    session?: Session.Info
    agent: Agent.Info
    model: Provider.Model
    toolIDs: readonly string[]
  }
  export interface ExecutionInput {
    toolID: string
    sessionID: string
    messageID: string
    callID: string
    args: unknown
    signal?: AbortSignal
  }
  export interface Source {
    select?(input: Readonly<SelectionInput>): Promise<readonly string[]>
    authorize?(input: Readonly<ExecutionInput>): Promise<void>
  }
  export class DeniedError extends Error {
    constructor(cause: unknown) {
      super("The host tool policy did not authorize this operation", { cause })
      this.name = "ToolPolicyDeniedError"
    }
  }
  const state = RuntimeContext.state(() => ({ source: undefined as Source | undefined }))
  const IDs = z.array(z.string().min(1).max(256)).max(10000)

  export function register(source: Source) {
    RuntimeContext.assertCompositionOpen("host tool policy")
    if (state().source) throw new Error("Host tool policy is already registered")
    state().source = source
  }

  export async function select(input: SelectionInput): Promise<string[]> {
    const source = state().source
    if (!source?.select) return [...input.toolIDs]
    try {
      const chosen = IDs.parse(await source.select(Object.freeze(structuredClone(input))))
      const available = new Set(input.toolIDs)
      if (chosen.some((id) => !available.has(id))) throw new Error("Host selection widened the catalog")
      return [...new Set(chosen)]
    } catch (error) {
      throw new DeniedError(error)
    }
  }

  export async function authorize(input: ExecutionInput) {
    input.signal?.throwIfAborted()
    const source = state().source
    if (!source?.authorize) return
    try {
      const args = z.json().parse(structuredClone(input.args))
      await source.authorize(Object.freeze({ ...input, args }))
    } catch (error) {
      input.signal?.throwIfAborted()
      throw new DeniedError(error)
    }
    input.signal?.throwIfAborted()
  }
}
