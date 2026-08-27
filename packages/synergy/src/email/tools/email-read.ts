import { formatLocalDate, formatLocalDateTime } from "@/util/time-format"
import type { SearchObject } from "imapflow"
import z from "zod"
import { Tool } from "../../tool/tool"
import { EmailImap } from "@/email/imap"
import {
  SCAN_WINDOW,
  SCAN_WINDOW_MAX,
  TEXT_SCAN_LIMIT,
  filterBySender,
  filterBySubject,
  hasServerKeys,
  matchesText,
  serverKeys,
  type SearchCriteria,
} from "@/email/search-filter"
import DESCRIPTION from "./email-read.txt"

const dateString = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: "Invalid date. Use ISO 8601 format, e.g. 2024-01-01.",
  })
  .describe("Date (ISO 8601)")

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
      text: z.string().optional().describe("Filter by keyword in the message body"),
      since: dateString.optional().describe("Emails received on or after this date (ISO 8601)"),
      before: dateString.optional().describe("Emails received before this date (ISO 8601)"),
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
      permission: "communication_email",
      patterns: [folder],
      metadata: {
        nonBypassable: true,
        folder,
        action: params.action,
      },
    })

    switch (params.action) {
      case "search": {
        const criteria = buildSearchCriteria(params.search)
        const result = await runSearch(folder, criteria, limit)
        return {
          title: `Search ${folder}`,
          output: `Found ${result.uids.length} email(s) in ${folder}.\nUIDs: ${result.uids.join(", ") || "none"}${
            result.truncated
              ? "\nNote: search window was exhausted; results may be incomplete. Narrow by date to scan older mail."
              : ""
          }`,
          metadata: { folder, uids: result.uids, count: result.uids.length, truncated: result.truncated },
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
          const date = formatLocalDate(s.date.getTime())
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
        let anyTruncated = false
        const allAttachments: EmailImap.EmailAttachment[] = []
        for (const uid of uids.slice(0, limit)) {
          const email = await EmailImap.fetchOne(folder, uid)
          if (!email) {
            results.push(`--- UID ${uid} ---\n(not found)`)
            continue
          }
          const date = formatLocalDateTime(email.date.getTime())
          const body = email.text ?? email.html ?? "(no body content)"
          const attachmentBlock = email.attachments.length
            ? "\n\nAttachments:\n" +
              email.attachments.map((a) => `- ${a.filename} (${a.size} bytes, ${a.contentType})`).join("\n")
            : ""
          const truncatedNote = email.truncated
            ? "\n\n(Message body exceeds the 10 MB size cap and was not parsed.)"
            : ""
          results.push(
            `--- UID ${email.uid} ---\n` +
              `From: ${email.from}\n` +
              `To: ${email.to}\n` +
              `Date: ${date}\n` +
              `Subject: ${email.subject}\n` +
              `Seen: ${email.seen}\n\n` +
              `${body}${attachmentBlock}${truncatedNote}`,
          )
          if (email.truncated) anyTruncated = true
          allAttachments.push(...email.attachments)
        }
        return {
          title: `Read ${folder}`,
          output: results.join("\n\n"),
          metadata: {
            folder,
            uids: uids.slice(0, limit),
            count: results.length,
            truncated: anyTruncated,
            attachments: allAttachments,
          },
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

function buildSearchCriteria(search?: z.infer<typeof parameters>["search"]): SearchCriteria {
  const criteria: SearchCriteria = {}
  if (!search) return criteria

  if (search.from) criteria.from = search.from
  if (search.subject) criteria.subject = search.subject
  if (search.text) criteria.text = search.text
  if (search.since !== undefined) criteria.since = new Date(search.since)
  if (search.before !== undefined) criteria.before = new Date(search.before)
  if (search.unseen !== undefined) criteria.seen = !search.unseen
  if (search.flagged !== undefined) criteria.flagged = search.flagged

  return criteria
}

async function runSearch(
  folder: string,
  criteria: SearchCriteria,
  limit: number,
): Promise<{ uids: number[]; truncated: boolean }> {
  const hasLocalFilter = Boolean(criteria.from || criteria.subject || criteria.text)
  const hasServer = hasServerKeys(criteria)
  const needsSummaries = Boolean(criteria.from || criteria.subject)

  // Server-side narrowing when date/flag keys are present; otherwise scan a
  // bounded newest-first window. Empty criteria list newest emails directly.
  let candidateUids: number[]
  let windowLimit: number | undefined
  let truncated = false
  if (hasServer) {
    candidateUids = await EmailImap.search(folder, serverKeys(criteria) as SearchObject)
    // Local filtering over a server-narrowed set must stay bounded: cap the
    // scan at the newest SCAN_WINDOW_MAX matches and flag possible incompleteness.
    if (needsSummaries && candidateUids.length > SCAN_WINDOW_MAX) {
      candidateUids = candidateUids.slice(-SCAN_WINDOW_MAX)
      truncated = true
    }
  } else if (hasLocalFilter) {
    candidateUids = await EmailImap.search(folder, { all: true }, { limit: SCAN_WINDOW })
    windowLimit = SCAN_WINDOW
  } else {
    candidateUids = await EmailImap.search(folder, { all: true }, { limit })
  }

  let matched = candidateUids

  // Local from/subject filtering over summaries (some servers ignore these keys).
  if (criteria.from) {
    const summaries = await EmailImap.fetchSummaries(folder, matched)
    matched = filterBySender(summaries, criteria.from).map((s) => s.uid)
  }
  if (criteria.subject) {
    const summaries = await EmailImap.fetchSummaries(folder, matched)
    matched = filterBySubject(summaries, criteria.subject).map((s) => s.uid)
  }

  // Widen once when the default window was exhausted (more mail may exist
  // beyond it) and local filtering came up short of the requested limit.
  const windowExhausted = windowLimit !== undefined && candidateUids.length >= windowLimit
  if (windowExhausted && (criteria.from || criteria.subject) && matched.length < limit) {
    const widened = await EmailImap.search(folder, { all: true }, { limit: SCAN_WINDOW_MAX })
    let widenedMatched = widened
    if (criteria.from) {
      const summaries = await EmailImap.fetchSummaries(folder, widenedMatched)
      widenedMatched = filterBySender(summaries, criteria.from).map((s) => s.uid)
    }
    if (criteria.subject) {
      const summaries = await EmailImap.fetchSummaries(folder, widenedMatched)
      widenedMatched = filterBySubject(summaries, criteria.subject).map((s) => s.uid)
    }
    matched = widenedMatched
    truncated = truncated || (widened.length >= SCAN_WINDOW_MAX && widenedMatched.length < limit)
  }

  // Local body-text scan over the newest bounded candidates.
  if (criteria.text) {
    const scanTargets = matched.slice(-TEXT_SCAN_LIMIT)
    const matchedUids: number[] = []
    for (const uid of scanTargets) {
      const detail = await EmailImap.fetchOne(folder, uid)
      if (detail && matchesText(detail, criteria.text)) matchedUids.push(uid)
    }
    if (matchedUids.length < limit && matched.length > scanTargets.length) truncated = true
    matched = matchedUids
  }

  // Newest-first, capped at the requested limit.
  return { uids: matched.slice(-limit).reverse(), truncated }
}
