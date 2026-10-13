import { z } from "zod"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
export const ChannelClarusAccount = z
  .object({
    enabled: z.boolean().optional().default(false),
    apiUrl: z
      .string()
      .optional()
      .describe(
        "Clarus REST API base URL override, including an optional path prefix; defaults to the configured Holos API base URL",
      ),
    agent: z.string().optional().describe("Primary Synergy agent for project and assignment Sessions"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.apiUrl) return
    try {
      validateHolosEndpoint(value.apiUrl, "api")
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiUrl"],
        message: error instanceof Error ? error.message : "Invalid Clarus apiUrl",
      })
    }
  })
  .meta({ ref: "ChannelClarusAccountConfig" })

export type ChannelClarusAccount = z.infer<typeof ChannelClarusAccount>

export const ChannelClarus = z
  .object({
    type: z.literal("clarus"),
    accounts: z.record(z.string(), ChannelClarusAccount),
  })
  .strict()
  .meta({ ref: "ChannelClarusConfig" })

export type ChannelClarus = z.infer<typeof ChannelClarus>

import { validateHolosEndpoint, validateHolosPortalUrl } from "@ericsanchezok/synergy-holos/holos/util"
import { ChannelConfigRegistry } from "@ericsanchezok/synergy-channels/config-schema"
declare module "@ericsanchezok/synergy-channels/config-schema" {
  interface ChannelKinds {
    clarus: ChannelClarus
  }
}
export function registerConfig() {
  ChannelConfigRegistry.register("clarus", ChannelClarus)
}
