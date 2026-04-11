import nodemailer from "nodemailer"
import type { Transporter } from "nodemailer"
import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Config } from "@/config/config"
import { Log } from "@/util/log"

export namespace Email {
  const log = Log.create({ service: "email" })
  const POOL_IDLE_MS = 60_000

  export const DisabledError = NamedError.create(
    "EmailDisabledError",
    z.object({
      message: z.string(),
    }),
  )

  export const NotConfiguredError = NamedError.create(
    "EmailNotConfiguredError",
    z.object({
      message: z.string(),
      missing: z.array(z.string()).optional(),
    }),
  )

  export const SendFailedError = NamedError.create(
    "EmailSendFailedError",
    z.object({
      message: z.string(),
      code: z.string().optional(),
      response: z.string().optional(),
      command: z.string().optional(),
    }),
  )

  type ResolvedConfig = {
    host: string
    port: number
    secure: boolean
    username: string
    password: string
    fromAddress: string
    fromName?: string
  }

  let pooledTransport: Transporter | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let transportKey: string | undefined

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => closePool(), POOL_IDLE_MS)
  }

  function closePool() {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
    if (pooledTransport) {
      pooledTransport.close()
      pooledTransport = undefined
    }
    transportKey = undefined
  }

  async function resolveConfig(): Promise<ResolvedConfig> {
    const config = await Config.get()
    const email = config.email
    if (!email) {
      throw new NotConfiguredError({
        message: "Email is not configured. Add an email section in Settings > Advanced or raw config.",
        missing: ["email"],
      })
    }
    if (email.enabled === false) {
      throw new DisabledError({
        message: "Email is disabled in config.",
      })
    }

    const missing: string[] = []
    if (!email.from?.address) missing.push("email.from.address")
    if (!email.smtp?.host) missing.push("email.smtp.host")
    if (!email.smtp?.port) missing.push("email.smtp.port")
    if (email.smtp?.secure === undefined) missing.push("email.smtp.secure")
    if (!email.smtp?.username) missing.push("email.smtp.username")
    if (!email.smtp?.password) missing.push("email.smtp.password")

    if (missing.length > 0) {
      throw new NotConfiguredError({
        message: `Email configuration is incomplete. Missing: ${missing.join(", ")}`,
        missing,
      })
    }

    const smtp = email.smtp!
    const from = email.from!
    return {
      host: smtp.host!,
      port: smtp.port!,
      secure: smtp.secure!,
      username: smtp.username!,
      password: smtp.password!,
      fromAddress: from.address!,
      fromName: from.name,
    }
  }

  async function getTransport() {
    const config = await resolveConfig()
    const nextKey = JSON.stringify(config)
    if (pooledTransport && transportKey === nextKey) return { transporter: pooledTransport, config }

    closePool()
    pooledTransport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.username, pass: config.password },
      pool: true,
      maxConnections: 2,
      maxMessages: 50,
    })
    transportKey = nextKey

    pooledTransport.on("error", (err) => {
      log.warn("smtp transport error, will reconnect on next send", { error: err.message })
      closePool()
    })

    return { transporter: pooledTransport, config }
  }

  export async function send(input: {
    to: string | string[]
    subject: string
    text: string
    html?: string
    attachments?: Array<{
      filename: string
      content: Buffer | string
      contentType?: string
    }>
  }) {
    const recipients = Array.isArray(input.to) ? input.to.join(", ") : input.to
    const { transporter, config } = await getTransport()
    try {
      const info = await transporter.sendMail({
        from: config.fromName ? `${config.fromName} <${config.fromAddress}>` : config.fromAddress,
        to: recipients,
        subject: input.subject,
        text: input.text,
        ...(input.html && { html: input.html }),
        ...(input.attachments && { attachments: input.attachments }),
      })
      resetIdleTimer()
      log.info("email sent", { messageId: info.messageId, to: recipients })
      return { messageId: info.messageId }
    } catch (error: any) {
      closePool()
      throw new SendFailedError({
        message: `Failed to send email: ${error?.message ?? String(error)}`,
        code: typeof error?.code === "string" ? error.code : undefined,
        response: typeof error?.response === "string" ? error.response : undefined,
        command: typeof error?.command === "string" ? error.command : undefined,
      })
    }
  }
}
