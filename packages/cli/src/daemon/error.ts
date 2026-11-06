import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"

export const DaemonUnsupportedPlatformError = NamedError.create(
  "DaemonUnsupportedPlatformError",
  z.object({
    platform: z.string(),
  }),
)
