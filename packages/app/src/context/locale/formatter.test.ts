import { describe, expect, test } from "bun:test"

import { createIntlFormatter } from "./formatter"
import type { ActiveLocale } from "./types"

describe("createIntlFormatter", () => {
  const en: ActiveLocale = "en"
  const zhCN: ActiveLocale = "zh-CN"

  describe("number", () => {
    test("formats with en locale", () => {
      const fmt = createIntlFormatter(() => en)
      expect(fmt.number(1234.56)).toBe("1,234.56")
    })

    test("formats with zh-CN locale", () => {
      const fmt = createIntlFormatter(() => zhCN)
      expect(fmt.number(1234.56)).toBe("1,234.56")
    })
  })

  describe("percent", () => {
    test("formats with en locale", () => {
      const fmt = createIntlFormatter(() => en)
      expect(fmt.percent(0.753)).toContain("75")
    })
  })

  describe("currency", () => {
    test("formats USD", () => {
      const fmt = createIntlFormatter(() => en)
      expect(fmt.currency(1234.56, "USD")).toContain("$")
    })

    test("formats CNY", () => {
      const fmt = createIntlFormatter(() => zhCN)
      expect(fmt.currency(1234.56, "CNY")).toContain("¥")
    })
  })

  describe("date", () => {
    test("does not force UTC", () => {
      const fmt = createIntlFormatter(() => en)
      const d = new Date(2026, 0, 15, 14, 30, 0)
      const result = fmt.date(d)
      expect(result).toContain("2026")
    })

    test("passes through caller options including timeZone", () => {
      const fmt = createIntlFormatter(() => en)
      const d = new Date(Date.UTC(2026, 0, 15, 14, 30, 0))
      const result = fmt.date(d, { timeZone: "UTC", timeZoneName: "short" })
      expect(result).toContain("2026")
      expect(result).toContain("UTC")
    })
  })

  describe("time", () => {
    test("formats time without forcing UTC", () => {
      const fmt = createIntlFormatter(() => en)
      const d = new Date(2026, 0, 15, 14, 30, 0)
      const result = fmt.time(d)
      expect(result.length).toBeGreaterThan(0)
    })

    test("accepts granular time fields without conflicting with the default style", () => {
      const fmt = createIntlFormatter(() => zhCN)
      const d = new Date(2026, 0, 15, 14, 30, 0)

      expect(() => fmt.time(d, { hour: "2-digit", minute: "2-digit" })).not.toThrow()
    })
  })

  describe("dateTime", () => {
    test("formats datetime without forcing UTC", () => {
      const fmt = createIntlFormatter(() => en)
      const d = new Date(2026, 0, 15, 14, 30, 0)
      const result = fmt.dateTime(d)
      expect(result).toContain("2026")
    })

    test("accepts granular date and time fields without conflicting with the default styles", () => {
      const fmt = createIntlFormatter(() => zhCN)
      const d = new Date(2026, 0, 15, 14, 30, 0)

      expect(() => fmt.dateTime(d, { year: "numeric", hour: "2-digit" })).not.toThrow()
    })
  })

  describe("list", () => {
    test("formats conjunctions with the active locale", () => {
      const enFormatter = createIntlFormatter(() => en)
      const zhFormatter = createIntlFormatter(() => zhCN)

      expect(enFormatter.list(["Alpha", "Beta", "Gamma"])).toBe("Alpha, Beta, and Gamma")
      expect(zhFormatter.list(["甲", "乙", "丙"])).toBe("甲、乙和丙")
    })
  })

  describe("relativeTime", () => {
    test("formats relative future", () => {
      const fmt = createIntlFormatter(() => en)
      const result = fmt.relative(new Date(Date.now() + 3600000))
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe("caching", () => {
    test("returns correct value after locale change", () => {
      let active: ActiveLocale = "en"
      const fmt = createIntlFormatter(() => active)
      const enVal = fmt.number(1234.56)
      active = "zh-CN"
      const zhVal = fmt.number(1234.56)
      expect(enVal).toBe("1,234.56")
      expect(zhVal).toBe("1,234.56")
    })

    test("locale getter called on each format call", () => {
      let calls = 0
      const fmt = createIntlFormatter(() => {
        calls++
        return "en"
      })
      fmt.number(1)
      fmt.number(2)
      expect(calls).toBe(2)
    })

    test("keeps formatter instances isolated by options", () => {
      const fmt = createIntlFormatter(() => en)

      expect(fmt.number(1.2, { maximumFractionDigits: 1 })).toBe("1.2")
      expect(fmt.number(1.2, { minimumFractionDigits: 3 })).toBe("1.200")

      const date = new Date(Date.UTC(2026, 0, 15, 12))
      expect(fmt.date(date, { year: "numeric", timeZone: "UTC" })).toBe("2026")
      expect(fmt.date(date, { month: "long", timeZone: "UTC" })).toBe("January")
    })
  })
})
