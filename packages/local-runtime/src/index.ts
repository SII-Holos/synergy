import { registerLocalRuntime } from "./register"
import { RuntimeHandle } from "@ericsanchezok/synergy-harness/lifecycle"
import { createLocalHost, createLocalStorage } from "./host"
import type { RuntimeHost } from "@ericsanchezok/synergy-harness/lifecycle/context"
import type { RuntimeStorage } from "@ericsanchezok/synergy-harness/lifecycle"

export { createLocalClient, RuntimeEvent, type RuntimeClient } from "./client"
export { RuntimeHandle, type RuntimeServices, type RuntimeNetwork } from "@ericsanchezok/synergy-harness/lifecycle"
export { registerLocalRuntime } from "./register"
export { createLocalHost, createLocalStorage } from "./host"

export type LocalRuntimeOptions = Omit<Parameters<typeof RuntimeHandle.open>[0], "host" | "composition" | "storage"> & {
  host?: RuntimeHost
  storage?: RuntimeStorage
}

export async function openLocalRuntime(options: LocalRuntimeOptions) {
  const host = options.host ?? createLocalHost()
  return RuntimeHandle.open({
    ...options,
    host,
    storage: options.storage ?? createLocalStorage(host, options.storageReporter),
    composition: { register: registerLocalRuntime },
  })
}
