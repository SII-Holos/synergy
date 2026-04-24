import z from "zod"
import { Tool } from "./tool"
import { EmailImap } from "@/email/imap"
import DESCRIPTION from "./email-read.txt"

const parameters = z.object({
  folder: z.string().optional().describe("Mailbox folder name, defaults to INBOX"),
  action: z
    .enum(["search", "summaries", "read", "markSeen"])
    .describe("What to do: search for UIDs, get summaries, read full email, or mark as seen"),
  uids: z.array(z.number().int().positive()).optional().describe("Email UIDs to fetch or mark as seen"),
  search: z
    .object({
      from: z.string().optional().describe("Filter by sender email address"),
      subject: z.string().optional().describe("Filter by subject keyword"),
      since: z.string().optional().describe("Emails received on or after this date (ISO 8601)"),
      before: z.string().optional().describe("Emails received before this date (ISO 8601)"),
      unseen: z.boolean().optional().describe("Only unread emails"),
      flagged: z.boolean().optional().describe("Only flagged/starred emails"),
    })
    .optional()
    .describe("Search criteria for finding emails"),
  limit: z.number().int().positive().max(100).optional().describe("Maximum results to return (default 20)"),
})

type ToolResult = {
  title: string
  output: string
  metadata: Record<string, any>
}

export const EmailReadTool = Tool.define("email_read", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx): Promise<ToolResult> {
    const folder = params.folder ?? "INBOX"
    const limit = params.limit ?? 20

    await ctx.ask({
      permission: "email",
      patterns: [folder],
      metadata: {
        folder,
        action: params.action,
      },
    })

    switch (params.action) {
      case "search": {
        const criteria = buildSearchCriteria(params.search)
        const uids = await EmailImap.search(folder, criteria, { limit })
        return {
          title: `Search ${folder}`,
          output: `Found ${uids.length} email(s) in ${folder}.\nUIDs: ${uids.join(", ") || "none"}`,
          metadata: { folder, uids, count: uids.length, truncated: false },
        }
      }

      case "summaries": {
        const uids = params.uids ?? []
        if (uids.length === 0) {
          return {
            title: `Summaries ${folder}`,
            output: "No UIDs provided. Use action=search first to get UIDs, or pass uids directly.",
            metadata: { folder, uids: [], count: 0, truncated: false },
          }
        }
        const summaries = await EmailImap.fetchSummaries(folder, uids.slice(0, limit))
        const lines = summaries.map((s) => {
          const date = s.date.toISOString().split("T")[0]
          const status = s.seen ? "✓" : "○"
          return `[${status}] ${date} | ${s.from} | ${s.subject}`
        })
        return {
          title: `Summaries ${folder}`,
          output: lines.join("\n") || "No emails found.",
          metadata: { folder, summaries, uids: uids.slice(0, limit), count: summaries.length, truncated: false },
        }
      }

      case "read": {
        const uids = params.uids ?? []
        if (uids.length === 0) {
          return {
            title: `Read ${folder}`,
            output: "No UIDs provided. Use action=search first to get UIDs, or pass uids directly.",
            metadata: { folder, uids: [], count: 0, truncated: false },
          }
        }
        const results: string[] = []
        for (const uid of uids.slice(0, limit)) {
          const email = await EmailImap.fetchOne(folder, uid)
          if (!email) {
            results.push(`--- UID ${uid} ---\n(not found)`)
            continue
          }
          const date = email.date.toISOString()
          const body = email.text ?? email.html ?? "(no body content)"
          results.push(
            `--- UID ${email.uid} ---\n` +
              `From: ${email.from}\n` +
              `To: ${email.to}\n` +
              `Date: ${date}\n` +
              `Subject: ${email.subject}\n` +
              `Seen: ${email.seen}\n\n` +
              `${body}`,
          )
        }
        return {
          title: `Read ${folder}`,
          output: results.join("\n\n"),
          metadata: { folder, uids: uids.slice(0, limit), truncated: false },
        }
      }

      case "markSeen": {
        const uids = params.uids ?? []
        if (uids.length === 0) {
          return {
            title: `Mark seen ${folder}`,
            output: "No UIDs provided.",
            metadata: { folder, uids: [], count: 0, truncated: false },
          }
        }
        await EmailImap.markSeen(folder, uids)
        return {
          title: `Mark seen ${folder}`,
          output: `Marked ${uids.length} email(s) as read in ${folder}.`,
          metadata: { folder, uids, count: uids.length, truncated: false },
        }
      }
    }
  },
})

function buildSearchCriteria(search?: z.infer<typeof parameters>["search"]): Record<string, any> {
  const criteria: Record<string, any> = {}
  if (!search) return criteria

  if (search.from) criteria.from = search.from
  if (search.subject) criteria.subject = search.subject
  if (search.since) criteria.since = new Date(search.since)
  if (search.before) criteria.before = new Date(search.before)
  if (search.unseen === true) criteria.seen = false
  if (search.flagged === true) criteria.flagged = true

  return criteria
}
