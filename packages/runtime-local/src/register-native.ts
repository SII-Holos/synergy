import { ScopeStartup } from "@ericsanchezok/synergy-harness/scope/startup"
import { SandboxHost } from "@ericsanchezok/synergy-harness/sandbox/host"
import { FileWatcher } from "./file/watcher"
import { SandboxBackend } from "./sandbox/backend"

export function registerLocalNativeRuntime(): void {
  SandboxHost.register(SandboxBackend)
  ScopeStartup.register({
    name: "file-watcher",
    phase: "surface",
    after: ["resume-pending"],
    init: () => FileWatcher.init(),
  })
}
