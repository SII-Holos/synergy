import { describe, expect, test } from "bun:test"
import { contextStatusAriaLabel, openContextPanel } from "../../../src/components/status-bar/context-status-model"

const presentation = {
  formatNumber: (value: number) => `n:${value}`,
  formatPercent: (value: number) => `p:${value}`,
  usageUnavailable: "usage unavailable",
  formatUsage: (percent: string) => `${percent} used`,
  formatLabel: (tokens: string, usage: string) => `Open Context, ${tokens} input tokens, ${usage}`,
}

describe("Context status button", () => {
  test("does not open Context without a session", async () => {
    let calls = 0
    const opened = await openContextPanel({
      sessionID: undefined,
      openPanel: () => {
        calls++
      },
    })
    expect(opened).toBe(false)
    expect(calls).toBe(0)
  })

  test("opens or activates the Context singleton", async () => {
    const calls: unknown[][] = []
    const opened = await openContextPanel({ sessionID: "ses_context", openPanel: (...args) => calls.push(args) })
    expect(opened).toBe(true)
    expect(calls).toEqual([["context", { reuseExisting: true }]])
  })

  test("injects localized formatting and labels for assistive technology", () => {
    expect(contextStatusAriaLabel({ exactInputTokens: 1_200, contextPercentage: 75, ...presentation })).toBe(
      "Open Context, n:1200 input tokens, p:0.75 used",
    )
    expect(contextStatusAriaLabel({ exactInputTokens: 1_200, contextPercentage: null, ...presentation })).toBe(
      "Open Context, n:1200 input tokens, usage unavailable",
    )
  })
})
