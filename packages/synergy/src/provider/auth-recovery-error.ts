import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"

export const ProviderAuthRecoveryError = NamedError.create(
  "ProviderAuthenticationRequiredError",
  z.object({
    providerID: z.string(),
    failureCode: z.string(),
    actionRequired: z.literal(true),
    message: z.string(),
  }),
)
