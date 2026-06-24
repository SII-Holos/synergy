import { describe, expect, test } from "bun:test"
import { getApprovalAudit } from "../src/utils/approval-audit"

const empty = { icon: null, iconClass: "", tooltip: "" }

describe("getApprovalAudit", () => {
  // ─── auto_allowed — mode-based icon ───────────────────────

  test("auto_allowed guarded mode uses shield-check icon", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "guarded", risk: "high" })
    expect(r.icon).toBe("shield-check")
  })

  test("auto_allowed autonomous mode uses orbit icon", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "autonomous", risk: "high" })
    expect(r.icon).toBe("orbit")
  })

  test("auto_allowed full_access mode hides icon (always empty in full_access)", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "full_access", risk: "high" })
    expect(r.icon).toBeNull()
    expect(r.iconClass).toBe("")
  })

  test("auto_allowed unknown mode falls back to badge-check", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "nonexistent", risk: "high" })
    expect(r.icon).toBe("badge-check")
  })

  test("auto_allowed missing mode falls back to badge-check", () => {
    const r = getApprovalAudit({ status: "auto_allowed", risk: "high" })
    expect(r.icon).toBe("badge-check")
  })

  // ─── auto_allowed — mode-based color, not risk-based ──────

  test("auto_allowed guarded + high risk → success green (NOT critical red)", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "guarded", risk: "high" })
    expect(r.iconClass).toBe("text-icon-success-base")
  })

  test("auto_allowed autonomous + high risk → interactive blue", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "autonomous", risk: "high" })
    expect(r.iconClass).toBe("text-icon-interactive-base")
  })
  test("auto_allowed full_access + high risk hides icon (always empty)", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "full_access", risk: "high" })
    expect(r.iconClass).toBe("")
  })

  test("auto_allowed unknown mode + high risk → neutral base", () => {
    const r = getApprovalAudit({ status: "auto_allowed", risk: "high" })
    expect(r.iconClass).toBe("text-icon-base")
  })

  test("regression: guarded auto_allowed high-risk iconClass is NOT critical red", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "guarded", risk: "high" })
    expect(r.iconClass).not.toBe("text-icon-critical-base")
  })

  // ─── user_allowed — always human stamp, always green ──────

  test("user_allowed icon is stamp regardless of risk or mode", () => {
    const r = getApprovalAudit({ status: "user_allowed", risk: "high", mode: "autonomous" })
    expect(r.icon).toBe("stamp")
  })

  test("user_allowed color is success green regardless of risk", () => {
    const r = getApprovalAudit({ status: "user_allowed", risk: "high" })
    expect(r.iconClass).toBe("text-icon-success-base")
  })

  test("user_allowed color is success green even with low risk", () => {
    const r = getApprovalAudit({ status: "user_allowed", risk: "low", mode: "guarded" })
    expect(r.iconClass).toBe("text-icon-success-base")
  })

  // ─── denied / blocked — always badge-x / octagon / shield-x, always critical ──

  test("user_denied → badge-x icon, critical color", () => {
    const r = getApprovalAudit({ status: "user_denied" })
    expect(r.icon).toBe("badge-x")
    expect(r.iconClass).toBe("text-icon-critical-base")
  })

  test("auto_denied → octagon-alert icon, critical color", () => {
    const r = getApprovalAudit({ status: "auto_denied" })
    expect(r.icon).toBe("octagon-alert")
    expect(r.iconClass).toBe("text-icon-critical-base")
  })

  test("policy_denied → octagon-alert icon, critical color", () => {
    const r = getApprovalAudit({ status: "policy_denied" })
    expect(r.icon).toBe("octagon-alert")
    expect(r.iconClass).toBe("text-icon-critical-base")
  })

  test("sandbox_blocked → shield-x icon, critical color", () => {
    const r = getApprovalAudit({ status: "sandbox_blocked" })
    expect(r.icon).toBe("shield-x")
    expect(r.iconClass).toBe("text-icon-critical-base")
  })

  // ─── pending_user — hourglass, neutral ────────────────────

  test("pending_user icon is hourglass", () => {
    const r = getApprovalAudit({ status: "pending_user" })
    expect(r.icon).toBe("hourglass")
  })

  test("pending_user color is neutral even with high risk", () => {
    const r = getApprovalAudit({ status: "pending_user", risk: "high" })
    expect(r.iconClass).toBe("text-icon-base")
  })

  // ─── empty / null / not_required states ───────────────────

  test("null approval returns empty", () => {
    expect(getApprovalAudit(null)).toEqual(empty)
  })

  test("undefined approval returns empty", () => {
    expect(getApprovalAudit(undefined)).toEqual(empty)
  })

  test("empty object returns empty", () => {
    expect(getApprovalAudit({})).toEqual(empty)
  })

  test("not_required status returns empty", () => {
    expect(getApprovalAudit({ status: "not_required" })).toEqual(empty)
  })

  test("unknown status returns empty", () => {
    const r = getApprovalAudit({ status: "made_up_status" })
    expect(r).toEqual(empty)
  })

  // ─── tooltip ──────────────────────────────────────────────

  test("user_allowed tooltip line 1 starts with label and risk", () => {
    const r = getApprovalAudit({ status: "user_allowed", risk: "medium" })
    expect(r.tooltip).toMatch(/^User approved · Medium risk/)
  })

  test("explicit reason appears as tooltip line 2", () => {
    const r = getApprovalAudit({
      status: "auto_allowed",
      mode: "guarded",
      risk: "medium",
      reason: "Custom explanation here",
    })
    expect(r.tooltip).toContain("\nCustom explanation here")
  })

  test("tooltip is present for auto_allowed", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "guarded", risk: "medium" })
    expect(r.tooltip.length).toBeGreaterThan(0)
    expect(r.tooltip).toContain("\n")
  })
})

// ─── icon hiding rules ─────────────────────────────────────────
describe("getApprovalAudit icon hiding", () => {
  test("auto_allowed + low risk hides icon (returns empty)", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "guarded", risk: "low" })
    expect(r.icon).toBeNull()
    expect(r.iconClass).toBe("")
    expect(r.tooltip).toBe("")
  })

  test("auto_allowed + low risk hides icon in autonomous mode", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "autonomous", risk: "low" })
    expect(r.icon).toBeNull()
    expect(r.iconClass).toBe("")
    expect(r.tooltip).toBe("")
  })

  test("auto_allowed + low risk hides icon in full_access mode", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "full_access", risk: "low" })
    expect(r.icon).toBeNull()
    expect(r.iconClass).toBe("")
    expect(r.tooltip).toBe("")
  })

  test("auto_allowed + medium risk still shows icon (guarded)", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "guarded", risk: "medium" })
    expect(r.icon).not.toBeNull()
    expect(r.iconClass).not.toBe("")
  })

  test("auto_allowed + high risk still shows icon (guarded)", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "guarded", risk: "high" })
    expect(r.icon).not.toBeNull()
    expect(r.iconClass).not.toBe("")
  })

  test("auto_allowed + medium risk still shows icon (autonomous)", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "autonomous", risk: "medium" })
    expect(r.icon).not.toBeNull()
    expect(r.iconClass).not.toBe("")
  })

  // ─── full_access hides ALL auto_allowed icons ─────────────────

  test("full_access hides auto_allowed + medium risk icon", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "full_access", risk: "medium" })
    expect(r.icon).toBeNull()
    expect(r.iconClass).toBe("")
    expect(r.tooltip).toBe("")
  })

  test("full_access hides auto_allowed + high risk icon", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "full_access", risk: "high" })
    expect(r.icon).toBeNull()
    expect(r.iconClass).toBe("")
    expect(r.tooltip).toBe("")
  })

  // ─── non-auto_allowed statuses are NOT hidden ────────────────

  test("pending_user is NOT hidden (always shows icon)", () => {
    const r = getApprovalAudit({ status: "pending_user", risk: "low" })
    expect(r.icon).not.toBeNull()
    expect(r.iconClass).not.toBe("")
  })

  test("user_allowed is NOT hidden (always shows icon)", () => {
    const r = getApprovalAudit({ status: "user_allowed", risk: "low", mode: "guarded" })
    expect(r.icon).not.toBeNull()
    expect(r.iconClass).not.toBe("")
  })

  test("user_denied is NOT hidden (always shows icon)", () => {
    const r = getApprovalAudit({ status: "user_denied", risk: "low" })
    expect(r.icon).not.toBeNull()
    expect(r.iconClass).not.toBe("")
  })

  test("auto_denied is NOT hidden (always shows icon)", () => {
    const r = getApprovalAudit({ status: "auto_denied", risk: "low" })
    expect(r.icon).not.toBeNull()
    expect(r.iconClass).not.toBe("")
  })
})
