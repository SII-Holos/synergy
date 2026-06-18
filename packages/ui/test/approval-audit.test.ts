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

  test("auto_allowed full_access mode uses shield-alert icon", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "full_access", risk: "high" })
    expect(r.icon).toBe("shield-alert")
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

  test("auto_allowed full_access + high risk → warning orange", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "full_access", risk: "high" })
    expect(r.iconClass).toBe("text-icon-warning-base")
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
      risk: "low",
      reason: "Custom explanation here",
    })
    expect(r.tooltip).toContain("\nCustom explanation here")
  })

  test("tooltip is present for auto_allowed", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "guarded", risk: "low" })
    expect(r.tooltip.length).toBeGreaterThan(0)
    expect(r.tooltip).toContain("\n")
  })
})
