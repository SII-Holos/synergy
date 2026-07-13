import { describe, expect, test } from "bun:test"
import { ObservabilityRedaction } from "../../src/observability/redaction"
import { ProcessAttribution } from "../../src/process/attribution"

describe("ProcessAttribution", () => {
  test("parses Linux proc status memory and parent fields", () => {
    const parsed = ProcessAttribution.__test.parseStatusText(
      ["Name:\tbun", "State:\tS (sleeping)", "PPid:\t123", "VmRSS:\t2048 kB", "Threads:\t7"].join("\n"),
    )

    expect(parsed.ppid).toBe(123)
    expect(parsed.rssBytes).toBe(2048 * 1024)
    expect(parsed.state).toBe("S (sleeping)")
    expect(parsed.threads).toBe(7)
  })

  test("finds recursive descendants from pid parent links", () => {
    const processes = new Map([
      [1, { pid: 1, ppid: 0 }],
      [2, { pid: 2, ppid: 1 }],
      [3, { pid: 3, ppid: 2 }],
      [4, { pid: 4, ppid: 1 }],
      [5, { pid: 5, ppid: 999 }],
    ])

    expect(ProcessAttribution.__test.descendantPidsFrom(processes, 1).sort()).toEqual([2, 3, 4])
  })

  test("summarizes arbitrary cgroup pid sets", () => {
    const processes = new Map([
      [1, { pid: 1, ppid: 0, rssBytes: 100 }],
      [2, { pid: 2, ppid: 1, rssBytes: 300 }],
      [3, { pid: 3, ppid: 2, rssBytes: 200 }],
    ])

    const summary = ProcessAttribution.__test.summarizePids([1, 3], processes, 2)

    expect(summary.count).toBe(2)
    expect(summary.rssBytes).toBe(300)
    expect(summary.top.map((item) => item.pid)).toEqual([3, 1])
  })

  test("default collection avoids detailed command attribution", () => {
    const summary = ProcessAttribution.collect(process.pid, { topN: 1 })
    if (summary.topChildren.length > 0) {
      expect(summary.topChildren[0].command).toBeUndefined()
      expect(summary.topChildren[0].wchan).toBeUndefined()
    }
  })

  test("collects multiple process roots from one snapshot", () => {
    const memory = ProcessAttribution.memoryByRoot([process.pid])
    expect(memory.get(process.pid)?.rootRssBytes).toBeGreaterThan(0)
  })

  test("redacts sk-prefixed secrets in captured commands", () => {
    expect(ObservabilityRedaction.text("cmd --key sk-1234567890abcdef")).toContain("[redacted]")
  })
})
