import {
  RuntimeHandle,
  createLocalHost,
  createLocalStorage,
  registerLocalRuntime,
} from "@ericsanchezok/synergy-local-runtime"
import { registerLibrary, disposeLibrary } from "@ericsanchezok/synergy-library/register"
import { registerAgentWorkerEntrypoint } from "@ericsanchezok/synergy-harness/session/agent-turn/process-host"
import type { Composition } from "../composition"

function register() {
  registerLocalRuntime()
  registerLibrary()
  registerAgentWorkerEntrypoint(new URL("../worker.ts", import.meta.url))
}

export default {
  id: "core-library",
  register,
  open(options) {
    const host = options.host ?? createLocalHost()
    return RuntimeHandle.open({
      ...options,
      host,
      storage: options.storage ?? createLocalStorage(host, options.storageReporter),
      composition: { register, services: () => ({ disposeExtensions: disposeLibrary }) },
    })
  },
} satisfies Composition
