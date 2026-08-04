import { ImapFlow } from "imapflow"
import type { SearchObject } from "imapflow"
import { simpleParser } from "mailparser"
import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Config } from "@/config/config"
import { Log } from "@/util/log"

export namespace EmailImap {
  const log = Log.create({ service: "email-imap" })

  /** Hard cap for a single message body download (source bytes, pre-parse). */
  export const EMAIL_MAX_BYTES = 10 * 1024 * 1024

  export const DisabledError = NamedError.create(
    "EmailImapDisabledError",
    z.object({
      message: z.string(),
    }),
  )

  export const NotConfiguredError = NamedError.create(
    "EmailImapNotConfiguredError",
    z.object({
      message: z.string(),
      missing: z.array(z.string()).optional(),
    }),
  )

  export const FetchFailedError = NamedError.create(
    "EmailImapFetchFailedError",
    z.object({
      message: z.string(),
    }),
  )

  type ResolvedConfig = {
    host: string
    port: number
    secure: boolean
    username: string
    password: string
  }

  async function resolveConfig(): Promise<ResolvedConfig> {
    const config = await Config.current()
    const email = config.email
    if (!email) {
      throw new NotConfiguredError({
        message: "Email is not configured. Add an email section in Settings > Email or 110-email.jsonc.",
        missing: ["email"],
      })
    }
    if (email.enabled === false) {
      throw new DisabledError({
        message: "Email is disabled in config.",
      })
    }

    const missing: string[] = []
    if (!email.imap?.host) missing.push("email.imap.host")
    if (!email.imap?.port) missing.push("email.imap.port")
    if (email.imap?.secure === undefined) missing.push("email.imap.secure")
    if (!email.imap?.username) missing.push("email.imap.username")
    if (!email.imap?.password) missing.push("email.imap.password")

    if (missing.length > 0) {
      throw new NotConfiguredError({
        message: `IMAP configuration is incomplete. Missing: ${missing.join(", ")}`,
        missing,
      })
    }

    const imap = email.imap!
    return {
      host: imap.host!,
      port: imap.port!,
      secure: imap.secure!,
      username: imap.username!,
      password: imap.password!,
    }
  }

  // resolveConfig runs before the try block so NotConfiguredError/DisabledError
  // propagate unwrapped; only transport-level failures become FetchFailedError.
  async function withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const config = await resolveConfig()
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.username, pass: config.password },
      logger: false,
    })

    try {
      await client.connect()
      return await fn(client)
    } catch (error: any) {
      log.warn("imap operation failed", { error })
      throw new FetchFailedError({
        message: `IMAP operation failed: ${error?.message ?? String(error)}`,
      })
    } finally {
      try {
        await client.logout()
      } catch {
        // ignore logout errors
      }
    }
  }

  export type EmailSummary = {
    uid: number
    subject: string
    from: string
    to: string
    date: Date
    seen: boolean
  }

  export type EmailAttachment = {
    filename: string
    contentType: string
    size: number
  }

  export type EmailDetail = {
    uid: number
    subject: string
    from: string
    to: string
    date: Date
    text?: string
    html?: string
    seen: boolean
    attachments: EmailAttachment[]
    /** True when the message exceeded EMAIL_MAX_BYTES and the body was not parsed. */
    truncated?: boolean
  }

  export async function search(
    folder: string,
    criteria: SearchObject,
    options?: { limit?: number },
  ): Promise<number[]> {
    return withClient(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        const uids = await client.search(criteria, { uid: true })
        if (Array.isArray(uids) && options?.limit && uids.length > options.limit) {
          // Newest-first ordering contract.
          return uids.slice(-options.limit)
        }
        return Array.isArray(uids) ? uids : []
      } finally {
        lock.release()
      }
    })
  }

  export async function fetchSummaries(folder: string, uids: number[]): Promise<EmailSummary[]> {
    if (uids.length === 0) return []
    return withClient(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        const results: EmailSummary[] = []
        const messages = await client.fetchAll(uids.join(","), { envelope: true, flags: true }, { uid: true })
        for (const msg of messages) {
          const env = msg.envelope
          if (!env) continue
          results.push({
            uid: msg.uid,
            subject: env.subject ?? "(no subject)",
            from:
              env.from
                ?.map((a: { name?: string; address?: string }) => `${a.name ?? ""} <${a.address ?? ""}>`.trim())
                .join(", ") ?? "",
            to:
              env.to
                ?.map((a: { name?: string; address?: string }) => `${a.name ?? ""} <${a.address ?? ""}>`.trim())
                .join(", ") ?? "",
            date: env.date ?? new Date(0),
            seen: msg.flags?.has("\\Seen") ?? false,
          })
        }
        return results
      } finally {
        lock.release()
      }
    })
  }

  export async function fetchOne(folder: string, uid: number): Promise<EmailDetail | undefined> {
    return withClient(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        const msg = await client.fetchOne(uid, { envelope: true, flags: true }, { uid: true })
        if (!msg || !msg.envelope) return undefined

        const env = msg.envelope
        const { content, meta } = await client.download(String(uid), undefined, {
          uid: true,
          maxBytes: EMAIL_MAX_BYTES,
        })
        if (!content) return undefined

        // LimitedPassthrough silently drops bytes past the cap, so detect
        // truncation from the server-reported size and stop reading early.
        const truncated = typeof meta?.expectedSize === "number" && meta.expectedSize > EMAIL_MAX_BYTES
        const raw = await collectBuffer(content)

        let text: string | undefined
        let html: string | undefined
        let attachments: EmailAttachment[] = []
        if (!truncated) {
          try {
            const parsed = await parseMessage(raw)
            text = parsed.text
            html = parsed.html
            attachments = parsed.attachments
          } catch (error) {
            log.warn("mailparser failed, returning envelope only", { error })
          }
        }

        return {
          uid: msg.uid,
          subject: env.subject ?? "(no subject)",
          from:
            env.from
              ?.map((a: { name?: string; address?: string }) => `${a.name ?? ""} <${a.address ?? ""}>`.trim())
              .join(", ") ?? "",
          to:
            env.to
              ?.map((a: { name?: string; address?: string }) => `${a.name ?? ""} <${a.address ?? ""}>`.trim())
              .join(", ") ?? "",
          date: env.date ?? new Date(0),
          text,
          html,
          seen: msg.flags?.has("\\Seen") ?? false,
          attachments,
          truncated,
        }
      } finally {
        lock.release()
      }
    })
  }

  export async function markSeen(folder: string, uids: number[]): Promise<void> {
    if (uids.length === 0) return
    return withClient(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true })
      } finally {
        lock.release()
      }
    })
  }

  export type ParsedMessage = {
    text?: string
    html?: string
    attachments: EmailAttachment[]
  }

  /**
   * Decode a raw RFC822 message with mailparser: transfer-encoding and charset
   * decoding for text/html bodies, plus attachment metadata (content is
   * discarded — only names/sizes/content types are returned).
   */
  export async function parseMessage(raw: Buffer | string): Promise<ParsedMessage> {
    const parsed = await simpleParser(raw)
    return {
      text: typeof parsed.text === "string" && parsed.text.length > 0 ? parsed.text : undefined,
      html: typeof parsed.html === "string" && parsed.html.length > 0 ? parsed.html : undefined,
      attachments: parsed.attachments.map((attachment) => ({
        filename: attachment.filename ?? "unnamed",
        contentType: attachment.contentType ?? "application/octet-stream",
        size: attachment.size ?? 0,
      })),
    }
  }

  /** Collect a download stream, stopping once EMAIL_MAX_BYTES is reached. */
  async function collectBuffer(stream: AsyncIterable<Buffer | Uint8Array>): Promise<Buffer> {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = EMAIL_MAX_BYTES - total
      if (remaining <= 0) break
      if (buffer.length > remaining) {
        chunks.push(buffer.subarray(0, remaining))
        break
      }
      chunks.push(buffer)
      total += buffer.length
    }
    return Buffer.concat(chunks)
  }
}
