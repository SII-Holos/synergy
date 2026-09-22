import { openLocalRuntime, registerLocalRuntime } from "@ericsanchezok/synergy-runtime-local"
import type { Composition } from "../composition"

export default {
  id: "core",
  register() {
    registerLocalRuntime()
  },
  open: openLocalRuntime,
} satisfies Composition
