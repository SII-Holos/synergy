import { ImapFlow } from "imapflow"
import type { SearchObject } from "imapflow"
import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Config } from "@/config/config"
import { Log } from "@/util/log"

export namespace EmailImap {
  const log = Log.create({ service: "email-imap" })

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
      log.warn("imap operation failed", { error: error?.message })
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

  export type EmailDetail = {
    uid: number
    subject: string
    from: string
    to: string
    date: Date
    text?: string
    html?: string
    seen: boolean
  }

  export async function listFolders(): Promise<string[]> {
    return withClient(async (client) => {
      const mailboxes = await client.list()
      return mailboxes.map((mb: { path: string }) => mb.path)
    })
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
        const msg = await client.fetchOne(uid, { envelope: true, flags: true, bodyStructure: true }, { uid: true })
        if (!msg) return undefined

        const env = msg.envelope
        if (!env) return undefined

        let text: string | undefined
        let html: string | undefined

        const textPart = msg.bodyStructure ? findPart(msg.bodyStructure, "text/plain") : undefined
        const htmlPart = msg.bodyStructure ? findPart(msg.bodyStructure, "text/html") : undefined

        if (textPart) {
          const { content } = await client.download(uid, textPart.part, { uid: true })
          text = await streamToBuffer(content)
        }
        if (htmlPart) {
          const { content } = await client.download(uid, htmlPart.part, { uid: true })
          html = await streamToBuffer(content)
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

  function findPart(node: any, type: string): { part: string; encoding: string } | undefined {
    if (node.type === type) {
      return { part: node.part, encoding: node.encoding }
    }
    if (node.childNodes) {
      for (const child of node.childNodes) {
        const found = findPart(child, type)
        if (found) return found
      }
    }
    return undefined
  }

  async function streamToBuffer(stream: any): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString("utf-8")
  }
}
