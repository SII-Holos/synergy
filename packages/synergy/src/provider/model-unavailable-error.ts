import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"

export const ProviderModelUnavailableError = NamedError.create(
  "ProviderModelUnavailableError",
  z.object({
    providerID: z.string(),
    modelID: z.string(),
    reason: z.enum(["not_in_catalog", "rejected_by_provider"]),
  }),
)
