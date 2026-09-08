import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import z from "zod"
import { validateHolosEndpoint, validateHolosPortalUrl } from "@ericsanchezok/synergy-connections/holos/util"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
export const FeishuGroupSessionScope = z
  .enum(["group", "group_sender", "group_topic", "group_topic_sender", "group_thread"])
  .describe(
    "How group chat sessions are scoped: group = shared, group_sender = per sender, group_topic = per topic, group_topic_sender = per topic+sender, group_thread = one session per Feishu thread or top-level request",
  )

export type FeishuGroupSessionScope = z.infer<typeof FeishuGroupSessionScope>

export const ChannelFeishuAccount = z
  .object({
    enabled: z.boolean().optional().default(true),
    appId: z.string().describe("Feishu app ID"),
    appSecret: z.string().describe("Feishu app secret"),
    domain: z.enum(["feishu", "lark"]).optional().describe("Feishu domain (feishu for China, lark for international)"),
    allowDM: z.boolean().optional().default(true).describe("Allow direct messages"),
    allowGroup: z.boolean().optional().default(true).describe("Allow group messages"),
    requireMention: z.boolean().optional().default(true).describe("Require @mention in group chats"),
    botOpenId: z.string().optional().describe("Bot open_id used to verify real @mentions in group chats"),
    projectDir: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Project directory whose Scope owns sessions for this Feishu account"),
    streaming: z.boolean().optional().describe("Enable streaming card updates"),
    responseFormat: z
      .enum(["text", "markdown"])
      .optional()
      .describe("Format for ordinary outbound text messages (markdown renders through a CardKit card)"),
    streamingThrottleMs: z
      .number()
      .int()
      .positive()
      .optional()
      .default(100)
      .describe("Minimum interval between streaming card updates in ms"),
    groupSessionScope: FeishuGroupSessionScope.optional()
      .default("group")
      .describe("Session scoping strategy for group chats"),
    inboundDebounceMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(0)
      .describe("Debounce rapid-fire messages from the same sender in the same chat (0 = disabled)"),
    model: z
      .string()
      .optional()
      .describe("Model to use for this account in providerID/modelID format (e.g. openai/gpt-4o)"),
    variant: z.string().optional().describe("Model variant to use with this account model (e.g. low, high, max)"),
    resolveSenderNames: z
      .boolean()
      .optional()
      .default(true)
      .describe("Resolve sender display names via Feishu contact API"),
    replyInThread: z.boolean().optional().default(false).describe("Reply in thread when message is part of a topic"),
  })
  .strict()
  .meta({ ref: "ChannelFeishuAccountConfig" })

export type ChannelFeishuAccount = z.infer<typeof ChannelFeishuAccount>

export const ChannelFeishu = z
  .object({
    type: z.literal("feishu"),
    accounts: z.record(z.string(), ChannelFeishuAccount),
    domain: z.enum(["feishu", "lark"]).optional().describe("Default domain for all accounts"),
    streaming: z.boolean().optional().default(true).describe("Default streaming setting for all accounts"),
    responseFormat: z
      .enum(["text", "markdown"])
      .optional()
      .default("markdown")
      .describe("Default outbound text format for all accounts"),
  })
  .strict()
  .meta({ ref: "ChannelFeishuConfig" })

export type ChannelFeishu = z.infer<typeof ChannelFeishu>

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

export const Holos = z
  .object({
    enabled: z.boolean().optional().default(true).describe("Enable the Holos runtime connection"),
    apiUrl: z.string().optional().default("https://api.holosai.io").describe("Holos API base URL"),
    wsUrl: z.string().optional().default("wss://api.holosai.io").describe("Holos WebSocket base URL"),
    portalUrl: z
      .string()
      .optional()
      .default("https://www.holosai.io")
      .describe("Holos portal URL for browser-facing pages (bind/start)"),
  })
  .strict()
  .superRefine((value, ctx) => {
    const checks: Array<{ path: string; url?: string; kind: "api" | "ws" | "portal" }> = [
      { path: "apiUrl", url: value.apiUrl, kind: "api" },
      { path: "wsUrl", url: value.wsUrl, kind: "ws" },
      { path: "portalUrl", url: value.portalUrl, kind: "portal" },
    ]
    for (const check of checks) {
      if (!check.url) continue
      try {
        if (check.kind === "portal") validateHolosPortalUrl(check.url)
        else validateHolosEndpoint(check.url, check.kind)
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [check.path],
          message: error instanceof Error ? error.message : `Invalid Holos ${check.kind} URL`,
        })
      }
    }
  })
  .meta({ ref: "HolosConfig" })

export type Holos = z.infer<typeof Holos>

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

export const Channel = z.discriminatedUnion("type", [ChannelFeishu, ChannelClarus, ChannelGithub])

export type Channel = z.infer<typeof Channel>

export const EmailSmtp = z
  .object({
    host: z.string().optional().describe("SMTP server hostname"),
    port: z.number().int().positive().optional().describe("SMTP server port"),
    secure: z.boolean().optional().describe("Use TLS/SSL for the SMTP connection"),
    username: z.string().optional().describe("SMTP username"),
    password: z.string().optional().describe("SMTP password or app token"),
  })
  .strict()
  .meta({ ref: "EmailSmtpConfig" })

export type EmailSmtp = z.infer<typeof EmailSmtp>

export const EmailImap = z
  .object({
    host: z.string().optional().describe("IMAP server hostname"),
    port: z.number().int().positive().optional().describe("IMAP server port"),
    secure: z.boolean().optional().describe("Use TLS/SSL for the IMAP connection"),
    username: z.string().optional().describe("IMAP username"),
    password: z.string().optional().describe("IMAP password or app token"),
  })
  .strict()
  .meta({ ref: "EmailImapConfig" })

export type EmailImap = z.infer<typeof EmailImap>

export const EmailFrom = z
  .object({
    address: z.string().optional().describe("Sender email address"),
    name: z.string().optional().describe("Sender display name"),
  })
  .strict()
  .meta({ ref: "EmailFromConfig" })

export type EmailFrom = z.infer<typeof EmailFrom>

export const Email = z
  .object({
    enabled: z.boolean().optional().describe("Enable email features"),
    from: EmailFrom.optional().describe("Sender identity for outgoing emails"),
    smtp: EmailSmtp.optional().describe("SMTP transport settings for outgoing emails"),
    imap: EmailImap.optional().describe("IMAP settings for reading emails"),
  })
  .strict()
  .meta({ ref: "EmailConfig" })

export type Email = z.infer<typeof Email>

export const GithubIdentitySync = z
  .object({
    enabled: z.boolean().optional().describe("Sync git user.name/user.email from the connected GitHub account"),
    name: z
      .string()
      .nullable()
      .optional()
      .describe("Optional git user.name override (defaults to the GitHub account login). null clears the override"),
    email: z
      .string()
      .nullable()
      .optional()
      .describe("Optional git user.email override (defaults to the GitHub noreply email). null clears the override"),
  })
  .strict()
  .meta({ ref: "GithubIdentitySyncConfig" })

export type GithubIdentitySync = z.infer<typeof GithubIdentitySync>

export const GithubWatch = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe("Allow GitHub agenda triggers (PR/issue/workflow status polling). Default: true"),
    defaultIntervalMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Default poll interval for GitHub agenda triggers in milliseconds (default 300000)"),
  })
  .strict()
  .meta({ ref: "GithubWatchConfig" })

export type GithubWatch = z.infer<typeof GithubWatch>

export const Github = z
  .object({
    identitySync: GithubIdentitySync.optional().describe("Git identity sync settings"),
    watch: GithubWatch.optional().describe("GitHub agenda trigger settings"),
  })
  .strict()
  .meta({ ref: "GithubConfig" })

export type Github = z.infer<typeof Github>

export const ConfigShape = {
  channel: z
    .record(z.string(), Channel)
    .optional()
    .describe("Channel configurations for messaging platform integrations"),
  holos: Holos.optional().describe("Holos platform configuration"),
  email: Email.optional().describe("Outgoing email configuration"),
  github: Github.optional().describe("GitHub integration settings (git identity sync, agenda watch)"),
  enterprise: z
    .object({
      url: z.string().optional().describe("Enterprise URL"),
    })
    .optional(),
}

export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>

declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
type ConfigShapeType = typeof ConfigShape

export function registerConfig() {
  ConfigExtensions.register("connections", {
    shape: ConfigShape,
    references(raw, providerID) {
      const config = raw as ConfigValues
      const result: string[] = []
      for (const [channelID, channel] of Object.entries(config.channel ?? {})) {
        if (channel.type !== "feishu") continue
        for (const [accountID, account] of Object.entries(channel.accounts)) {
          if (account.model?.startsWith(`${providerID}/`))
            result.push(`channel.${channelID}.accounts.${accountID}.model`)
        }
      }
      return result
    },
    redact(raw, helpers) {
      const result = raw as ConfigValues
      const REDACTED_SENTINEL = helpers.sentinel
      const redactSecretShapedRecord = helpers.redact
      const mergeSecretShapedRecord = helpers.restore

      if (result.email?.smtp?.password) result.email.smtp.password = REDACTED_SENTINEL
      if (result.email?.imap?.password) result.email.imap.password = REDACTED_SENTINEL
      if (result.channel?.feishu?.accounts) {
        for (const account of Object.values(result.channel.feishu.accounts) as any[]) {
          if (account?.appSecret) account.appSecret = REDACTED_SENTINEL
        }
      }
    },
    restore(raw, previous, helpers) {
      const result = raw as ConfigValues
      const stored = previous as ConfigValues
      const REDACTED_SENTINEL = helpers.sentinel
      const redactSecretShapedRecord = helpers.redact
      const mergeSecretShapedRecord = helpers.restore

      if (result.email?.smtp?.password === REDACTED_SENTINEL && stored.email?.smtp?.password) {
        result.email.smtp.password = stored.email.smtp.password
      }
      if (result.email?.imap?.password === REDACTED_SENTINEL && stored.email?.imap?.password) {
        result.email.imap.password = stored.email.imap.password
      }
      if (result.channel?.feishu?.accounts && stored.channel?.feishu?.accounts) {
        for (const [key, account] of Object.entries(result.channel.feishu.accounts) as [string, any][]) {
          if (account?.appSecret === REDACTED_SENTINEL) {
            const storedAccount = (stored.channel.feishu.accounts as Record<string, any>)[key]
            if (storedAccount?.appSecret) account.appSecret = storedAccount.appSecret
          }
        }
      }
    },
  })
  for (const domain of [
    {
      id: "channels",
      filename: "90-channels.jsonc",
      label: "Channels",
      ownedKeys: ["channel"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "channels",
      importable: true,
    },
    {
      id: "holos",
      filename: "100-holos.jsonc",
      label: "Holos",
      ownedKeys: ["holos", "enterprise"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "holos",
      importable: true,
    },
    {
      id: "email",
      filename: "110-email.jsonc",
      label: "Email",
      ownedKeys: ["email"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "email",
      importable: true,
    },
    {
      id: "github",
      filename: "115-github.jsonc",
      label: "GitHub",
      ownedKeys: ["github"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "github",
      importable: true,
    },
  ] satisfies ConfigDomain.Definition[])
    ConfigDomain.register(domain)
}
registerConfig()

export async function readConfig(): Promise<ConfigValues> {
  const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
  return Config.current()
}
