import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
export interface TerminalHookDeliveryResult {
  status: "delivered" | "plugin_mismatch" | "no_handler" | "failed"
  handlerCount: number
  succeededHandlerCount?: number
  error?: string
}
export type TerminalHookDeliverer = (
  pluginId: string,
  pluginGeneration: string,
  pointName: string,
  input: unknown,
) => Promise<TerminalHookDeliveryResult>
const state = RuntimeContext.state(() => ({ deliver: undefined as TerminalHookDeliverer | undefined }))
export function setTerminalHookDeliverer(deliver: TerminalHookDeliverer) {
  RuntimeContext.assertCompositionOpen("Blueprint terminal hook")
  if (state().deliver) throw new Error("Blueprint terminal hook is already registered")
  state().deliver = deliver
}
export async function deliverTerminalHook(
  ...args: Parameters<TerminalHookDeliverer>
): Promise<TerminalHookDeliveryResult> {
  const deliver = state().deliver
  if (!deliver) return { status: "failed", handlerCount: 0, error: "Blueprint plugin bridge is not selected" }
  return deliver(...args)
}
