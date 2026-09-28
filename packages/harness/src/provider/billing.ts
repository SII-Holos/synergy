import { z } from "zod"

export namespace ProviderBilling {
  export const Mode = z
    .enum(["api", "subscription", "local", "unknown"])
    .describe(
      "Commercial billing basis. Model overrides connection, then the declared provider profile. Unclassified or mixed profiles remain unknown; authentication does not determine billing.",
    )
  export type Mode = z.infer<typeof Mode>
  export function resolve(input: { model?: Mode; connection?: Mode; profile?: Mode }): Mode {
    return input.model ?? input.connection ?? input.profile ?? "unknown"
  }
}
