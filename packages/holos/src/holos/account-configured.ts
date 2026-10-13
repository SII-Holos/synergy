import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
const state = RuntimeContext.state(() => new Map<string, (agentId: string) => Promise<unknown>>())
export function registerAccountConfigured(owner: string, fn: (agentId: string) => Promise<unknown>) {
  RuntimeContext.assertCompositionOpen("Holos account configured")
  if (state().has(owner)) throw new Error(`Duplicate Holos account callback ${owner}`)
  state().set(owner, fn)
}
export async function accountConfigured(agentId: string) {
  for (const fn of state().values()) await fn(agentId)
}
