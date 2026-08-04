// Hybrid search: server-side SEARCH for date/flag keys, local filtering for
// sender/subject/text. Local filtering exists because some IMAP servers
// (e.g. 163 Coremail) ignore SUBJECT/FROM/TEXT search keys and return empty
// results even for matching messages. All helpers are pure and preserve input
// order; the tool layer guarantees newest-first input.
//
// Constants bound the local scan window so a large mailbox cannot cause an
// unbounded number of IMAP fetches or bodies.

export const SCAN_WINDOW = 200
export const SCAN_WINDOW_MAX = 1000
export const TEXT_SCAN_LIMIT = 50

export type SearchCriteria = {
  from?: string
  subject?: string
  text?: string
  since?: Date
  before?: Date
  seen?: boolean
  flagged?: boolean
}

export type EmailSummaryLike = {
  uid: number
  subject: string
  from: string
}

export type EmailDetailLike = {
  uid: number
  text?: string
  html?: string
}

/** True when the criteria contain any key the IMAP server can evaluate. */
export function hasServerKeys(criteria: SearchCriteria): boolean {
  return (
    criteria.since !== undefined ||
    criteria.before !== undefined ||
    criteria.seen !== undefined ||
    criteria.flagged !== undefined
  )
}

/**
 * The subset of criteria that maps to server-side IMAP SEARCH keys.
 * `from`/`subject`/`text` are excluded: some servers ignore those keys, so
 * they are applied locally over the bounded scan window instead.
 */
export function serverKeys(criteria: SearchCriteria): SearchCriteria {
  const keys: SearchCriteria = {}
  if (criteria.since !== undefined) keys.since = criteria.since
  if (criteria.before !== undefined) keys.before = criteria.before
  if (criteria.seen !== undefined) keys.seen = criteria.seen
  if (criteria.flagged !== undefined) keys.flagged = criteria.flagged
  return keys
}

/** Case-insensitive substring match on the sender field. */
export function filterBySender(summaries: EmailSummaryLike[], from: string): EmailSummaryLike[] {
  const needle = from.toLowerCase()
  return summaries.filter((s) => s.from.toLowerCase().includes(needle))
}

/** Case-insensitive substring match on the subject field. */
export function filterBySubject(summaries: EmailSummaryLike[], subject: string): EmailSummaryLike[] {
  const needle = subject.toLowerCase()
  return summaries.filter((s) => s.subject.toLowerCase().includes(needle))
}

/** Case-insensitive substring match on the decoded plain-text body. */
export function matchesText(detail: EmailDetailLike, text: string): boolean {
  const body = (detail.text ?? detail.html ?? "").toLowerCase()
  return body.includes(text.toLowerCase())
}
