import { beforeAll, describe, expect, mock, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import type { EmailReadTool as EmailReadToolType } from "../../src/email/tools/email-read"

// Fake IMAP service: module-level injection so the tool's hybrid search
// orchestration is exercised without a real server.
const state: {
  searchCalls: Array<{ criteria: Record<string, unknown>; options?: { limit?: number } }>
  summariesCalls: number[][]
  fetchOneCalls: number[]
  markSeenCalls: number[][]
  uidPool: number[]
  summaries: Map<number, { uid: number; subject: string; from: string; to: string; date: Date; seen: boolean }>
  details: Map<
    number,
    {
      uid: number
      subject: string
      from: string
      to: string
      date: Date
      seen: boolean
      text?: string
      html?: string
      attachments: Array<{ filename: string; contentType: string; size: number }>
      truncated?: boolean
    }
  >
} = {
  searchCalls: [],
  summariesCalls: [],
  fetchOneCalls: [],
  markSeenCalls: [],
  uidPool: [],
  summaries: new Map(),
  details: new Map(),
}

function resetState() {
  state.searchCalls = []
  state.summariesCalls = []
  state.fetchOneCalls = []
  state.markSeenCalls = []
  state.uidPool = []
  state.summaries.clear()
  state.details.clear()
}

/** Seed N newest-first emails; uid 1000 is the oldest, 1000+N-1 the newest. */
function seedEmails(count: number, overrides: Partial<{ from: string; subject: string; text: string }>[] = []) {
  const uids: number[] = []
  for (let i = 0; i < count; i++) {
    const uid = 1000 + i
    const override = overrides[i] ?? {}
    uids.push(uid)
    state.summaries.set(uid, {
      uid,
      subject: override.subject ?? `Subject ${i}`,
      from: override.from ?? `sender${i}@example.com`,
      to: "agent@example.com",
      date: new Date(Date.UTC(2026, 7, 4, 12, i)),
      seen: false,
    })
    state.details.set(uid, {
      uid,
      subject: state.summaries.get(uid)!.subject,
      from: state.summaries.get(uid)!.from,
      to: "agent@example.com",
      date: state.summaries.get(uid)!.date,
      seen: false,
      text: override.text ?? `Body text of email ${i}`,
      attachments: [],
    })
  }
  state.uidPool = uids
}

const imapModule = pathToFileURL(path.resolve(import.meta.dir, "../../src/email/imap.ts")).href

mock.module(imapModule, () => ({
  EmailImap: {
    EMAIL_MAX_BYTES: 10 * 1024 * 1024,
    search: async (folder: string, criteria: Record<string, unknown>, options?: { limit?: number }) => {
      state.searchCalls.push({ criteria, options })
      const pool = state.uidPool
      if (options?.limit && pool.length > options.limit) return pool.slice(-options.limit)
      return pool
    },
    fetchSummaries: async (folder: string, uids: number[]) => {
      state.summariesCalls.push(uids)
      return uids.map((uid) => state.summaries.get(uid)).filter((s): s is NonNullable<typeof s> => Boolean(s))
    },
    fetchOne: async (folder: string, uid: number) => {
      state.fetchOneCalls.push(uid)
      return state.details.get(uid)
    },
    markSeen: async (folder: string, uids: number[]) => {
      state.markSeenCalls.push(uids)
    },
  },
}))

let EmailReadTool: typeof EmailReadToolType

beforeAll(async () => {
  const mod = await import("../../src/email/tools/email-read")
  EmailReadTool = mod.EmailReadTool
})

const fakeCtx = {
  sessionID: "test",
  messageID: "",
  agent: "test",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

async function runTool(params: Record<string, unknown>) {
  const tool = await EmailReadTool.init()
  return tool.execute(params as never, fakeCtx as never)
}

describe("email_read search orchestration", () => {
  test("date-only criteria go to the server and stay newest-first", async () => {
    resetState()
    seedEmails(5)
    const result = await runTool({
      action: "search",
      search: { since: "2026-08-01", before: "2026-08-05" },
      limit: 3,
    })
    expect(state.searchCalls).toHaveLength(1)
    expect(state.searchCalls[0].criteria).toEqual({
      since: new Date("2026-08-01"),
      before: new Date("2026-08-05"),
    })
    // Newest-first ordering: the server branch returns ascending UIDs, the
    // tool reverses them so the newest message comes first.
    expect(result.metadata.uids).toEqual([1004, 1003, 1002])
  })

  test("from filter is applied locally over a bounded window", async () => {
    resetState()
    seedEmails(3, [{ from: "scholight@x.com" }, { from: "other@x.com" }, { from: "scholight@y.com" }])
    const result = await runTool({
      action: "search",
      search: { from: "scholight" },
      limit: 10,
    })
    // Local filter path: windowed all-search + summaries fetch.
    expect(state.searchCalls).toHaveLength(1)
    expect(state.searchCalls[0].criteria).toEqual({ all: true })
    expect(state.searchCalls[0].options?.limit).toBe(200)
    expect(state.summariesCalls.length).toBeGreaterThan(0)
    expect(result.metadata.uids).toEqual([1002, 1000])
  })

  test("subject filter is applied locally", async () => {
    resetState()
    seedEmails(3, [{ subject: "AAAI 2027 deadline" }, { subject: "Other" }, { subject: "AAAI call" }])
    const result = await runTool({
      action: "search",
      search: { subject: "AAAI" },
      limit: 10,
    })
    expect(result.metadata.uids).toEqual([1002, 1000])
  })

  test("combined server + local criteria narrow server-side first", async () => {
    resetState()
    seedEmails(4)
    const result = await runTool({
      action: "search",
      search: { since: "2026-08-01", from: "sender2" },
      limit: 10,
    })
    expect(state.searchCalls).toHaveLength(1)
    expect(state.searchCalls[0].criteria).toEqual({ since: new Date("2026-08-01") })
    expect(result.metadata.uids).toEqual([1002])
  })

  test("text filter scans bodies over the bounded candidate set", async () => {
    resetState()
    seedEmails(4, [{ text: "Alpha report" }, {}, { text: "alpha again" }, {}])
    const result = await runTool({
      action: "search",
      search: { text: "alpha" },
      limit: 10,
    })
    expect(state.fetchOneCalls.length).toBeGreaterThan(0)
    expect(result.metadata.uids).toEqual([1002, 1000])
  })

  test("text filter scans the newest messages, not the oldest", async () => {
    resetState()
    // 60 emails: only the newest (uid 1059) matches. The old implementation
    // scanned slice(0, 50) — the oldest 50 — and missed it.
    const overrides: Partial<{ from: string; subject: string; text: string }>[] = []
    overrides[59] = { text: "needle-in-newest" }
    seedEmails(60, overrides)
    const result = await runTool({
      action: "search",
      search: { text: "needle-in-newest" },
      limit: 10,
    })
    expect(result.metadata.uids).toEqual([1059])
    expect(result.metadata.truncated).toBe(true)
  })

  test("window widening runs when the default window is exhausted and filtering comes up short", async () => {
    resetState()
    // 250 emails: the newest 200 fill the default window, the only "hit" sits
    // in the older 50 that are visible only after widening.
    const overrides: Partial<{ from: string; subject: string; text: string }>[] = []
    overrides[0] = { from: "hit@old.example.com" }
    seedEmails(250, overrides)
    const result = await runTool({
      action: "search",
      search: { from: "hit" },
      limit: 5,
    })
    // Initial windowed scan + one widening scan with SCAN_WINDOW_MAX.
    expect(state.searchCalls).toHaveLength(2)
    expect(state.searchCalls[0].options?.limit).toBe(200)
    expect(state.searchCalls[1].options?.limit).toBe(1000)
    expect(result.metadata.uids).toEqual([1000])
    expect(result.metadata.truncated).toBe(false)
  })

  test("truncation flagged when even the widened window falls short", async () => {
    resetState()
    // 1200 emails: the only "hit" is older than the widened (1000) window.
    const overrides: Partial<{ from: string; subject: string; text: string }>[] = []
    overrides[0] = { from: "hit@ancient.example.com" }
    seedEmails(1200, overrides)
    const result = await runTool({
      action: "search",
      search: { from: "hit" },
      limit: 5,
    })
    expect(result.metadata.uids).toEqual([])
    expect(result.metadata.truncated).toBe(true)
  })

  test("no truncation when the window is not exhausted even if matches are few", async () => {
    resetState()
    seedEmails(5, [
      { from: "hit@x.com" },
      { from: "miss@x.com" },
      { from: "miss@x.com" },
      { from: "miss@x.com" },
      { from: "miss@x.com" },
    ])
    const result = await runTool({
      action: "search",
      search: { from: "hit" },
      limit: 5,
    })
    // 5 emails < 200 window: nothing was cut off, so no truncation flag.
    expect(result.metadata.uids).toEqual([1000])
    expect(result.metadata.truncated).toBe(false)
  })

  test("empty criteria returns newest emails without truncation", async () => {
    resetState()
    seedEmails(6)
    const result = await runTool({ action: "search", limit: 4 })
    expect(state.searchCalls[0].options?.limit).toBe(4)
    expect(result.metadata.uids).toEqual([1005, 1004, 1003, 1002])
    expect(result.metadata.truncated).toBe(false)
  })
})

describe("email_read read action", () => {
  test("renders decoded body and attachment metadata", async () => {
    resetState()
    seedEmails(1, [{ from: "sender0@example.com", subject: "With attachment" }])
    const detail = state.details.get(1000)!
    detail.text = "Decoded body without =3D artifacts"
    detail.attachments = [
      { filename: "report.pdf", contentType: "application/pdf", size: 2048 },
      { filename: "notes.txt", contentType: "text/plain", size: 64 },
    ]
    const result = await runTool({ action: "read", uids: [1000] })
    expect(result.output).toContain("Decoded body without =3D artifacts")
    expect(result.output).toContain("- report.pdf (2048 bytes, application/pdf)")
    expect(result.output).toContain("- notes.txt (64 bytes, text/plain)")
    expect(result.metadata.attachments).toEqual([
      { filename: "report.pdf", contentType: "application/pdf", size: 2048 },
      { filename: "notes.txt", contentType: "text/plain", size: 64 },
    ])
  })

  test("flags truncated messages and reports them", async () => {
    resetState()
    seedEmails(1)
    const detail = state.details.get(1000)!
    detail.text = undefined
    detail.truncated = true
    const result = await runTool({ action: "read", uids: [1000] })
    expect(result.output).toContain("exceeds the 10 MB size cap")
    expect(result.metadata.truncated).toBe(true)
  })

  test("no UIDs returns guidance", async () => {
    resetState()
    const result = await runTool({ action: "read" })
    expect(result.output).toContain("No UIDs provided")
  })
})

describe("email_read parameter validation", () => {
  test("invalid since date is rejected with a clear error", async () => {
    resetState()
    seedEmails(3)
    await expect(runTool({ action: "search", search: { since: "garbage" } })).rejects.toThrow(/invalid arguments/)
  })

  test("valid ISO dates pass", async () => {
    resetState()
    seedEmails(3)
    const result = await runTool({ action: "search", search: { since: "2026-08-01" } })
    expect(result.metadata.uids.length).toBeGreaterThan(0)
  })
})

describe("email_read markSeen action", () => {
  test("forwards UIDs to the IMAP service", async () => {
    resetState()
    seedEmails(2)
    const result = await runTool({ action: "markSeen", uids: [1000, 1001] })
    expect(state.markSeenCalls).toEqual([[1000, 1001]])
    expect(result.output).toContain("Marked 2 email(s) as read")
  })
})
