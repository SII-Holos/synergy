import { createIntlFormatter } from "@/context/locale/formatter"
import { describe, expect, test } from "bun:test"
import { setupI18n as coreSetupI18n } from "@lingui/core"
import {
  formatWakeTime,
  formatDuration,
  statusLabel,
  triggerLabel,
  W,
} from "../../../src/components/session/wake-indicator-model"
import type { SessionAgendaItem } from "@ericsanchezok/synergy-sdk/client"

/** Build a minimal i18n with all wake-related messages registered (English defaults). */
function mockI18n() {
  const messages: Record<string, string> = {
    [W.conditional.id]: W.conditional.message!,
    [W.imminent.id]: W.imminent.message!,
    [W.inMinutes.id]: W.inMinutes.message!,
    [W.inHours.id]: W.inHours.message!,
    [W.tomorrowAt.id]: W.tomorrowAt.message!,
    [W.statusActive.id]: W.statusActive.message!,
    [W.statusPending.id]: W.statusPending.message!,
    [W.triggerAt.id]: W.triggerAt.message!,
    [W.triggerDelay.id]: W.triggerDelay.message!,
    [W.triggerEvery.id]: W.triggerEvery.message!,
    [W.triggerCron.id]: W.triggerCron.message!,
    [W.triggerWatch.id]: W.triggerWatch.message!,
    [W.triggerWebhook.id]: W.triggerWebhook.message!,
    [W.triggerPending.id]: W.triggerPending.message!,
    [W.panelTitle.id]: W.panelTitle.message!,
    [W.panelDescription.id]: W.panelDescription.message!,
    [W.tooltip.id]: W.tooltip.message!,
    [W.ariaLabel.id]: W.ariaLabel.message!,
    [W.collapse.id]: W.collapse.message!,
    [W.showAll.id]: W.showAll.message!,
    [W.joinToken.id]: W.joinToken.message!,
    "session.agenda.wake.unit.s": "seconds",
    "session.agenda.wake.unit.m": "minutes",
    "session.agenda.wake.unit.h": "hours",
    "session.agenda.wake.unit.d": "days",
    "session.agenda.wake.unit.w": "weeks",
    "session.agenda.wake.unit.ms": "ms",
  }
  const i18n = coreSetupI18n({ locale: "en" })
  i18n.loadAndActivate({ locale: "en", messages })
  return i18n
}

describe("wake-indicator W descriptors", () => {
  test("no Chinese literals in descriptor messages", () => {
    const descriptors = Object.values(W)
    for (const desc of descriptors) {
      if (desc.message) {
        expect(desc.message).not.toMatch(/[\u4e00-\u9fff]/)
        expect(desc.message).not.toMatch(/[\u3000-\u303f\uff00-\uffef]/)
      }
    }
  })

  test("all descriptors have explicit string IDs under session.agenda namespace", () => {
    for (const [_key, desc] of Object.entries(W)) {
      expect(typeof desc.id).toBe("string")
      expect(desc.id.length).toBeGreaterThan(0)
      expect(desc.id).toMatch(/^session\.agenda\./)
    }
  })
})

describe("formatWakeTime", () => {
  test("returns Conditional when nextRunAt is null", () => {
    const i18n = mockI18n()
    const fmt = createIntlFormatter(() => "en")
    expect(formatWakeTime(null, { i18n, fmt })).toBe("Conditional")
  })

  test("returns Imminent for times within a minute", () => {
    const i18n = mockI18n()
    const fmt = createIntlFormatter(() => "en")
    const in30s = Date.now() + 30_000
    expect(formatWakeTime(in30s, { i18n, fmt })).toBe("Imminent")
  })

  test("returns minutes for times under an hour (en)", () => {
    const i18n = mockI18n()
    const fmt = createIntlFormatter(() => "en")
    const in10min = Date.now() + 10 * 60_000
    const result = formatWakeTime(in10min, { i18n, fmt })
    expect(result).toMatch(/^\d+ minutes?$/)
  })

  test("returns hours for same-day times under a day (en)", () => {
    const i18n = mockI18n()
    const fmt = createIntlFormatter(() => "en")
    const now = new Date(2026, 0, 15, 10, 0, 0, 0).getTime()
    const in6h = now + 6 * 60 * 60_000
    const result = formatWakeTime(in6h, { i18n, fmt, now })
    expect(result).toMatch(/^\d+h$/)
  })

  test("uses Tomorrow at HH:MM for next-day times (en)", () => {
    const i18n = mockI18n()
    const fmt = createIntlFormatter(() => "en")
    const now = new Date(2026, 0, 15, 23, 0, 0, 0).getTime()
    const tomorrow = new Date(2026, 0, 16, 14, 30, 0, 0)
    const result = formatWakeTime(tomorrow.getTime(), { i18n, fmt, now })
    expect(result).toMatch(/^Tomorrow at \d{2}:\d{2}$/)
  })

  test("uses dateTime for far-future times (en)", () => {
    const i18n = mockI18n()
    const fmt = createIntlFormatter(() => "en")
    const far = Date.now() + 3 * 24 * 60 * 60_000
    const result = formatWakeTime(far, { i18n, fmt })
    expect(result).not.toContain("Tomorrow")
    expect(result.length).toBeGreaterThan(0)
  })

  test("uses dateTime for far-future times (zh-CN)", () => {
    const i18n = mockI18n()
    const fmt = createIntlFormatter(() => "zh-CN")
    const far = Date.now() + 3 * 24 * 60 * 60_000
    const result = formatWakeTime(far, { i18n, fmt })
    expect(result).not.toContain("Tomorrow")
    expect(result.length).toBeGreaterThan(0)
  })
})

describe("formatDuration", () => {
  test("returns undefined for undefined input", () => {
    const i18n = mockI18n()
    expect(formatDuration(undefined, { i18n })).toBeUndefined()
  })

  test("returns value unchanged for non-duration strings", () => {
    const i18n = mockI18n()
    expect(formatDuration("abc", { i18n })).toBe("abc")
  })

  test("formats second durations", () => {
    const i18n = mockI18n()
    expect(formatDuration("45s", { i18n })).toBe("45 seconds")
  })

  test("formats minute durations", () => {
    const i18n = mockI18n()
    expect(formatDuration("30m", { i18n })).toBe("30 minutes")
  })

  test("formats hour durations", () => {
    const i18n = mockI18n()
    expect(formatDuration("2h", { i18n })).toBe("2 hours")
  })
})

describe("statusLabel", () => {
  test("returns Active for active status", () => {
    const i18n = mockI18n()
    expect(statusLabel("active", { i18n })).toBe("Active")
  })

  test("returns Pending for pending status", () => {
    const i18n = mockI18n()
    expect(statusLabel("pending", { i18n })).toBe("Pending")
  })
})

describe("triggerLabel", () => {
  function makeItem(triggers: SessionAgendaItem["triggers"]): SessionAgendaItem {
    return {
      itemID: "test",
      title: "Test",
      status: "pending",
      nextRunAt: null,
      triggerTypes: [],
      triggers,
      global: false,
    }
  }

  test("at trigger returns One-time", () => {
    const i18n = mockI18n()
    expect(triggerLabel(makeItem([{ type: "at" }]), { i18n })).toBe("One-time")
  })

  test("delay trigger returns Delay 5 minutes", () => {
    const i18n = mockI18n()
    expect(triggerLabel(makeItem([{ type: "delay", delay: "5m" }]), { i18n })).toBe("Delay 5 minutes")
  })

  test("cron trigger returns Scheduled", () => {
    const i18n = mockI18n()
    expect(triggerLabel(makeItem([{ type: "cron" }]), { i18n })).toBe("Scheduled")
  })

  test("webhook trigger returns Webhook", () => {
    const i18n = mockI18n()
    expect(triggerLabel(makeItem([{ type: "webhook" }]), { i18n })).toBe("Webhook")
  })

  test("multiple triggers join with locale-aware separator", () => {
    const i18n = mockI18n()
    expect(triggerLabel(makeItem([{ type: "at" }, { type: "cron" }]), { i18n })).toBe("One-time, Scheduled")
  })
})
