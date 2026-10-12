import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import type { AgendaTypes } from "./types"
export namespace AgendaGithubSource {
  export interface Source {
    descriptions: Record<"watch" | "schedule", string>
    start(handler: (signal: AgendaTypes.FiredSignal, scopeID: string) => Promise<void>, items: AgendaTypes.Item[]): void
    stop(): void
    register(itemID: string, scopeID: string, triggers: AgendaTypes.Trigger[], options?: { hasRun?: boolean }): void
    unregister(itemID: string): void
    active(): { items: number; entries: number }
    check(toolName: string): Promise<{ title: string; output: string; metadata: Record<string, unknown> } | undefined>
  }
  const state = RuntimeContext.state(() => ({ source: undefined as Source | undefined }))
  export function registerSource(source: Source) {
    RuntimeContext.assertCompositionOpen("Agenda GitHub source")
    if (state().source) throw new Error("Agenda GitHub source already registered")
    state().source = source
  }
  export function description(kind: "watch" | "schedule", base: string) {
    const extra = state().source?.descriptions[kind]
    return extra ? `${base}\n\n${extra}` : base
  }
  export function selected() {
    return !!state().source
  }
  export function start(...args: Parameters<Source["start"]>) {
    state().source?.start(...args)
  }
  export function stop() {
    state().source?.stop()
  }
  export function register(...args: Parameters<Source["register"]>) {
    state().source?.register(...args)
  }
  export function unregister(itemID: string) {
    state().source?.unregister(itemID)
  }
  export function active() {
    return state().source?.active() ?? { items: 0, entries: 0 }
  }
  export async function check(toolName: string) {
    const source = state().source
    if (!source) throw new Error("GitHub Agenda integration is not selected")
    return source.check(toolName)
  }
}
