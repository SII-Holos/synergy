import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"

export const ProviderModelVariantUnavailableError = NamedError.create(
  "ProviderModelVariantUnavailableError",
  z.object({
    providerID: z.string(),
    modelID: z.string(),
    variant: z.string(),
    availableVariants: z.array(z.string()),
  }),
)
