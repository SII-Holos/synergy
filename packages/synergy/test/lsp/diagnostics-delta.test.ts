import { describe, expect, test } from "bun:test"
import type { LSPClient } from "../../src/lsp/client"
import { diffDiagnostics, formatDiagnosticDelta } from "../../src/lsp/diagnostics-delta"

const filePath = "/tmp/example.ts"
const otherFilePath = "/tmp/other.ts"

describe("diagnostics delta", () => {
  test("marks the delta unavailable when either snapshot is missing", () => {
    expect(diffDiagnostics(undefined, undefined, filePath)).toEqual({
      added: [],
      resolved: [],
      unchanged: 0,
      errored: true,
    })
  })

  test("detects unchanged diagnostics", () => {
    const unchanged = diagnostic(0, 1, "same error")

    expect(diffDiagnostics({ [filePath]: [unchanged] }, { [filePath]: [unchanged] }, filePath)).toEqual({
      added: [],
      resolved: [],
      unchanged: 1,
    })
  })

  test("detects added diagnostics", () => {
    const added = diagnostic(1, 1, "new error")

    expect(diffDiagnostics({ [filePath]: [] }, { [filePath]: [added] }, filePath)).toEqual({
      added: [added],
      resolved: [],
      unchanged: 0,
    })
  })

  test("detects resolved diagnostics", () => {
    const resolved = diagnostic(2, 2, "resolved warning")

    expect(diffDiagnostics({ [filePath]: [resolved] }, { [filePath]: [] }, filePath)).toEqual({
      added: [],
      resolved: [resolved],
      unchanged: 0,
    })
  })

  test("ignores diagnostics from other files", () => {
    const before = {
      [filePath]: [diagnostic(0, 1, "same error")],
      [otherFilePath]: [diagnostic(0, 1, "resolved project error")],
    }
    const after = {
      [filePath]: [diagnostic(0, 1, "same error")],
      [otherFilePath]: [diagnostic(1, 1, "new project error")],
    }

    expect(diffDiagnostics(before, after, filePath)).toEqual({ added: [], resolved: [], unchanged: 1 })
  })

  test("applies the severity predicate to added resolved and unchanged diagnostics", () => {
    const before = {
      [filePath]: [diagnostic(0, 1, "same error"), diagnostic(1, 2, "resolved warning")],
    }
    const after = {
      [filePath]: [diagnostic(0, 1, "same error"), diagnostic(2, 2, "new warning")],
    }

    expect(diffDiagnostics(before, after, filePath, (item) => item.severity === 1)).toEqual({
      added: [],
      resolved: [],
      unchanged: 1,
    })
  })

  test("formats added resolved and unchanged diagnostics", () => {
    const output = formatDiagnosticDelta({
      added: [diagnostic(2, 1, "new error")],
      resolved: [diagnostic(0, 2, "resolved warning")],
      unchanged: 3,
    })

    expect(output).toContain("New diagnostics introduced by this edit")
    expect(output).toContain("ERROR [3:1] new error")
    expect(output).toContain("Diagnostics resolved by this edit")
    expect(output).toContain("WARN [1:1] resolved warning")
    expect(output).toContain("Pre-existing diagnostics: 3 (unchanged)")
  })
})

function diagnostic(line: number, severity: 1 | 2, message: string): LSPClient.Diagnostic {
  return {
    severity,
    range: {
      start: { line, character: 0 },
      end: { line, character: 5 },
    },
    message,
    code: `TS${line}${severity}`,
  }
}
