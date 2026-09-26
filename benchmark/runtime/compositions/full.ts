import { registerFullPreset } from "@ericsanchezok/synergy-presets/registration"
import { PresetRuntimeHandle } from "@ericsanchezok/synergy-presets/server/runtime-handle"
import type { Composition } from "../composition"

export default {
  id: "full",
  register: registerFullPreset,
  open: PresetRuntimeHandle.openTask,
} satisfies Composition
