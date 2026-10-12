import { z } from "zod"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
export const ChannelGithubAccount = z
  .object({
    enabled: z.boolean().optional().default(true),
    repositories: z
      .array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use owner/repo form"))
      .default([])
      .describe("GitHub repositories to watch and respond to (owner/repo); may be empty and filled in later"),
    workspaceDir: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Directory under which per-repository checkouts are created. Each pull request or issue gets its own random-hash subdirectory with the branch checked out.",
      ),
    workspaceTtlHours: z
      .number()
      .int()
      .positive()
      .optional()
      .default(24)
      .describe(
        "Hours an unused per-thread checkout is kept before its local clone is removed. Session history is preserved; the checkout is recreated automatically the next time the thread is triggered.",
      ),
    pollingIntervalMs: z
      .number()
      .int()
      .positive()
      .optional()
      .default(300_000)
      .describe("Interval between GitHub API polls in milliseconds (default 5 minutes)"),
    autoReview: z
      .boolean()
      .optional()
      .default(true)
      .describe("Automatically review newly opened and updated pull requests"),
    autoRespond: z
      .boolean()
      .optional()
      .default(true)
      .describe("Respond to @mentions of the bot handle and questions in issues and pull requests"),
    agent: z.string().optional().describe("Agent used for GitHub channel sessions (defaults to github-channel-agent)"),
    mention: z
      .string()
      .optional()
      .describe(
        "GitHub handle users @-mention to summon the bot (defaults to the GitHub App slug resolved from the App identity)",
      ),
    model: z
      .string()
      .optional()
      .describe("Model to use for this account in providerID/modelID format (e.g. openai/gpt-4o)"),
    variant: z.string().optional().describe("Model variant to use with this account model (e.g. low, high, max)"),
  })
  .strict()
  .meta({ ref: "ChannelGithubAccountConfig" })

export type ChannelGithubAccount = z.infer<typeof ChannelGithubAccount>

export const ChannelGithub = z
  .object({
    type: z.literal("github"),
    accounts: z.record(z.string(), ChannelGithubAccount),
  })
  .strict()
  .meta({ ref: "ChannelGithubConfig" })

export type ChannelGithub = z.infer<typeof ChannelGithub>

import { ChannelConfigRegistry } from "@ericsanchezok/synergy-channels/config-schema"
declare module "@ericsanchezok/synergy-channels/config-schema" {
  interface ChannelKinds {
    github: ChannelGithub
  }
}
export function registerConfig() {
  ChannelConfigRegistry.register("github", ChannelGithub)
}
