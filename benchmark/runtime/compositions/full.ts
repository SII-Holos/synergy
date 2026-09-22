import { registerProductRuntime } from "@ericsanchezok/synergy-product-runtime/product-registration"
import { ProductRuntimeHandle } from "@ericsanchezok/synergy-product-runtime/server/runtime-handle"
import type { Composition } from "../composition"

export default {
  id: "full",
  register: registerProductRuntime,
  open: ProductRuntimeHandle.openTask,
} satisfies Composition
