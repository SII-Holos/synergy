import { describe, expect, test } from "bun:test"
import {
  SCAN_WINDOW,
  SCAN_WINDOW_MAX,
  TEXT_SCAN_LIMIT,
  filterBySender,
  filterBySubject,
  hasServerKeys,
  matchesText,
  serverKeys,
  type EmailDetailLike,
  type EmailSummaryLike,
  type SearchCriteria,
} from "../../src/email/search-filter"

const summaries: EmailSummaryLike[] = [
  { uid: 3, subject: "AAAI 2027 deadline", from: "AAAI 2027 <aaai2027-notifications@openreview.net>" },
  { uid: 2, subject: "Your Scholight survey is ready", from: "SanchezCloud <scholight@sanchezcloud.net>" },
  { uid: 1, subject: "Hello world", from: "四月雨季 <1686170055@qq.com>" },
]

describe("serverKeys", () => {
  test("keeps only date and flag keys", () => {
    const criteria: SearchCriteria = {
      from: "scholight",
      subject: "survey",
      text: "hello",
      since: new Date("2026-08-01"),
      before: new Date("2026-08-05"),
      seen: false,
      flagged: true,
    }
    expect(serverKeys(criteria)).toEqual({
      since: criteria.since,
      before: criteria.before,
      seen: false,
      flagged: true,
    })
  })

  test("returns empty object when only local keys are present", () => {
    expect(serverKeys({ from: "scholight", subject: "survey", text: "hello" })).toEqual({})
  })

  test("returns empty object for empty criteria", () => {
    expect(serverKeys({})).toEqual({})
  })
})

describe("hasServerKeys", () => {
  test("true when any date/flag key is present", () => {
    expect(hasServerKeys({ since: new Date() })).toBe(true)
    expect(hasServerKeys({ seen: false })).toBe(true)
    expect(hasServerKeys({ before: new Date() })).toBe(true)
    expect(hasServerKeys({ flagged: true })).toBe(true)
  })

  test("false for local-only or empty criteria", () => {
    expect(hasServerKeys({ from: "x" })).toBe(false)
    expect(hasServerKeys({ subject: "x", text: "y" })).toBe(false)
    expect(hasServerKeys({})).toBe(false)
  })
})

describe("filterBySender", () => {
  test("case-insensitive substring match", () => {
    expect(filterBySender(summaries, "SCHOLIGHT").map((s) => s.uid)).toEqual([2])
    expect(filterBySender(summaries, "openreview.net").map((s) => s.uid)).toEqual([3])
  })

  test("no match returns empty, preserves order", () => {
    expect(filterBySender(summaries, "nobody")).toEqual([])
    const hits = filterBySender(summaries, "a")
    expect(hits.map((s) => s.uid)).toEqual([3, 2])
  })
})

describe("filterBySubject", () => {
  test("case-insensitive substring match", () => {
    expect(filterBySubject(summaries, "DEADLINE").map((s) => s.uid)).toEqual([3])
    expect(filterBySubject(summaries, "survey").map((s) => s.uid)).toEqual([2])
  })

  test("no match returns empty", () => {
    expect(filterBySubject(summaries, "missing")).toEqual([])
  })
})

describe("matchesText", () => {
  const details: EmailDetailLike[] = [
    { uid: 3, text: "The report is ready to read.\nFinished at 6:50 AM UTC" },
    { uid: 2, html: "<html><body>HTML only body</body></html>" },
    { uid: 1, text: undefined, html: undefined },
  ]

  test("matches decoded text case-insensitively", () => {
    expect(matchesText(details[0], "REPORT IS READY")).toBe(true)
    expect(matchesText(details[0], "6:50 am")).toBe(true)
  })

  test("falls back to html when text is absent", () => {
    expect(matchesText(details[1], "html only")).toBe(true)
  })

  test("no body returns false", () => {
    expect(matchesText(details[2], "anything")).toBe(false)
  })
})

describe("constants", () => {
  test("bounded scan windows", () => {
    expect(SCAN_WINDOW).toBe(200)
    expect(SCAN_WINDOW_MAX).toBe(1000)
    expect(TEXT_SCAN_LIMIT).toBe(50)
  })
})
