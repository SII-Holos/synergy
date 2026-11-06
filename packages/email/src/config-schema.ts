import { z } from "zod"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
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

export const ConfigShape = { email: Email.optional() }
type ConfigShapeType = typeof ConfigShape
export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>
declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
const contribution: ConfigExtensions.Contribution = {
  shape: ConfigShape,
  redact(raw, helpers) {
    const result = raw as ConfigValues
    for (const kind of ["smtp", "imap"] as const) {
      if (result.email?.[kind]?.password) result.email[kind]!.password = helpers.sentinel
    }
  },
  restore(raw, previous, helpers) {
    const result = raw as ConfigValues
    const stored = previous as ConfigValues
    for (const kind of ["smtp", "imap"] as const) {
      if (result.email?.[kind]?.password === helpers.sentinel && stored.email?.[kind]?.password)
        result.email[kind]!.password = stored.email[kind]!.password
    }
  },
}
export function registerConfig() {
  ConfigExtensions.register("email", contribution)
  ConfigDomain.register({
    id: "email",
    filename: "110-email.jsonc",
    label: "Email",
    ownedKeys: ["email"],
    mergePolicy: "merge",
    reloadTargets: ["config"],
    uiSection: "email",
    importable: true,
  })
}
export async function readConfig(): Promise<ConfigValues> {
  const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
  return Config.current()
}
