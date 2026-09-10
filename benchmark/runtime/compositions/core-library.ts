import { openLocalRuntime, registerLocalRuntime } from "@ericsanchezok/synergy-runtime-local"
import { registerLibrary, disposeLibrary } from "@ericsanchezok/synergy-library/register"
import type { Composition } from "../composition"

export default {
  id: "core-library",
  async register() {
    registerLocalRuntime()
    registerLibrary()
  },
  open: (options) => openLocalRuntime({ ...options, services: { disposeExtensions: disposeLibrary } }),
} satisfies Composition
