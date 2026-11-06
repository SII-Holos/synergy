import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import type { Status } from "./types"
export namespace ChannelSetup {
  export type PrintStatuses = (statuses: Record<string, Status>) => void
  export interface Provider {
    id: string
    label: string
    configure(printOnly: boolean, serverURL: string, printStatuses: PrintStatuses): Promise<void>
  }
  const state = RuntimeContext.state(() => new Map<string, Provider>())
  export function register(provider: Provider) {
    RuntimeContext.assertCompositionOpen("Channel setup")
    if (state().has(provider.id)) throw new Error(`Duplicate Channel setup provider ${provider.id}`)
    state().set(provider.id, provider)
  }
  export function list() {
    return [...state().values()]
  }
  export function get(id: string) {
    return state().get(id)
  }
}
