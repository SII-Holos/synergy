import { ProductRuntimeHandle } from "@ericsanchezok/synergy-product-runtime/server/runtime-handle"
import type { Composition } from "../composition"

export default {
  id: "full",
  async register() {
    await import("@ericsanchezok/synergy-product-runtime/product-registration")
  },
  open: ProductRuntimeHandle.openTask,
} satisfies Composition
