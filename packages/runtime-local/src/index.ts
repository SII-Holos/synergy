import { registerLocalRuntime } from "./register"
import { RuntimeHandle } from "@ericsanchezok/synergy-harness/lifecycle"

export { createLocalClient, RuntimeEvent, type RuntimeClient } from "./client"
export { RuntimeHandle, type RuntimeServices, type RuntimeNetwork } from "@ericsanchezok/synergy-harness/lifecycle"
export { registerLocalRuntime } from "./register"

export async function openLocalRuntime(options: Parameters<typeof RuntimeHandle.open>[0]) {
  registerLocalRuntime()
  return RuntimeHandle.open(options)
}
