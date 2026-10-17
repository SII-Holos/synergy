import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
type Name = "agenda.run.before" | "agenda.run.after" | "agenda.run.error"
type Trigger = <T extends Record<string, unknown>>(name: Name, input: Record<string, unknown>, output: T) => Promise<T>
const state = RuntimeContext.state(() => ({ trigger: undefined as Trigger | undefined }))
export function registerAgendaHooks(trigger: Trigger) {
  RuntimeContext.assertCompositionOpen("agenda hooks")
  if (state().trigger) throw new Error("Agenda hook delivery already registered")
  state().trigger = trigger
}
export async function triggerAgendaHook<T extends Record<string, unknown>>(
  name: Name,
  input: Record<string, unknown>,
  output: T,
): Promise<T> {
  return state().trigger?.(name, input, output) ?? output
}
