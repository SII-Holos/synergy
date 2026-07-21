import { describe, expect, test } from "bun:test"
import { getApprovalAudit } from "../src/utils/approval-audit"

const empty = { icon: null, iconClass: "", tooltip: "" }
const visible = { visible: true }
const hidden = { visible: false }

describe("getApprovalAudit", () => {
  test("returns empty without approval metadata", () => {
    expect(getApprovalAudit(null)).toEqual(empty)
    expect(getApprovalAudit(undefined)).toEqual(empty)
    expect(getApprovalAudit({})).toEqual(empty)
    expect(getApprovalAudit({ status: "not_required", audit: visible })).toEqual(empty)
  })

  test("does not infer visibility without backend audit metadata", () => {
    expect(getApprovalAudit({ status: "auto_allowed", mode: "autonomous", risk: "medium" })).toEqual(empty)
    expect(getApprovalAudit({ status: "auto_denied", risk: "high" })).toEqual(empty)
  })

  test("hides approvals when audit marks them hidden", () => {
    expect(getApprovalAudit({ status: "auto_allowed", mode: "guarded", risk: "medium", audit: hidden })).toEqual(empty)
    expect(getApprovalAudit({ status: "auto_allowed", mode: "autonomous", risk: "low", audit: hidden })).toEqual(empty)
  })

  test("auto_allowed guarded mode uses shield-check when visible", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "guarded", risk: "medium", audit: visible })
    expect(r.icon).toBe("shield-check")
    expect(r.iconClass).toBe("text-icon-success-base")
  })

  test("auto_allowed autonomous mode uses orbit when visible", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "autonomous", risk: "medium", audit: visible })
    expect(r.icon).toBe("orbit")
    expect(r.iconClass).toBe("text-icon-interactive-base")
  })

  test("auto_allowed unknown mode falls back to badge-check when visible", () => {
    const r = getApprovalAudit({ status: "auto_allowed", mode: "nonexistent", risk: "medium", audit: visible })
    expect(r.icon).toBe("badge-check")
    expect(r.iconClass).toBe("text-icon-base")
  })

  test("user approvals are rendered when visible", () => {
    const r = getApprovalAudit({ status: "user_allowed", risk: "low", mode: "guarded", audit: visible })
    expect(r.icon).toBe("stamp")
    expect(r.iconClass).toBe("text-icon-success-base")
  })

  test("denied and blocked approvals are critical when visible", () => {
    expect(getApprovalAudit({ status: "user_denied", audit: visible }).icon).toBe("badge-x")
    expect(getApprovalAudit({ status: "auto_denied", audit: visible }).icon).toBe("octagon-alert")
    expect(getApprovalAudit({ status: "policy_denied", audit: visible }).icon).toBe("octagon-alert")
    expect(getApprovalAudit({ status: "sandbox_blocked", audit: visible }).icon).toBe("shield-x")
    expect(getApprovalAudit({ status: "auto_denied", audit: visible }).iconClass).toBe("text-icon-critical-base")
  })

  test("pending and pre-authorized approvals are rendered when visible", () => {
    expect(getApprovalAudit({ status: "pending_user", risk: "high", audit: visible }).icon).toBe("hourglass")
    expect(getApprovalAudit({ status: "pre_authorized", risk: "medium", audit: visible }).icon).toBe("badge-check")
  })

  test("unknown visible status returns empty", () => {
    expect(getApprovalAudit({ status: "made_up_status", audit: visible })).toEqual(empty)
  })

  test("tooltip includes label, risk, and reason", () => {
    const r = getApprovalAudit({
      status: "auto_allowed",
      mode: "autonomous",
      risk: "medium",
      reason: "Custom explanation here",
      audit: visible,
    })
    expect(r.tooltip).toMatch(/^Auto approved · Medium risk/)
    expect(r.tooltip).toContain("\nCustom explanation here")
  })

  test("tooltip includes evaluated SmartAllow risk and confidence", () => {
    const r = getApprovalAudit({
      status: "auto_allowed",
      risk: "low",
      audit: visible,
      smartAllow: { risk: "low", reason: "Routine operation", confidence: 0.92 },
    })

    expect(r.tooltip).toContain("\nSmart allow: low risk, 92% confidence")
  })

  test("tooltip explains when SmartAllow evaluation was skipped", () => {
    const r = getApprovalAudit({
      status: "auto_denied",
      risk: "high",
      audit: visible,
      smartAllow: { skipped: true, reason: "Non-bypassable capability" },
    })

    expect(r.tooltip).toContain("\nSmart allow skipped: Non-bypassable capability")
    expect(r.tooltip).not.toContain("unknown risk")
    expect(r.tooltip).not.toContain("0% confidence")
  })
})
