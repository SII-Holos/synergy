import { openLocalRuntime, registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime"
import type { Composition } from "../composition"

export default {
  id: "core",
  register() {
    registerLocalRuntime()
  },
  open: openLocalRuntime,
} satisfies Composition
