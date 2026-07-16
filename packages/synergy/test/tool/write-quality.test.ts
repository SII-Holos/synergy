import { afterEach, describe, expect, mock, test } from "bun:test"
import { Config } from "../../src/config/config"
import { LSP } from "../../src/lsp"
import type { LSPClient } from "../../src/lsp/client"
import { captureWriteDiagnosticsBefore, collectWriteDiagnostics } from "../../src/tool/write-quality"

const filePath = "/tmp/example.ts"
const otherFilePath = "/tmp/other.ts"
const originalConfigCurrent = Config.current
const originalTouchFile = LSP.touchFile
const originalDiagnostics = LSP.diagnostics

afterEach(() => {
  Config.current = originalConfigCurrent
  LSP.touchFile = originalTouchFile
  LSP.diagnostics = originalDiagnostics
})

describe("write diagnostics policy", () => {
  test("master switch disables post-write LSP collection", async () => {
    setConfig({
      lspWriteDiagnostics: false,
      lspDiagnostics: { severity: "warning", scope: "project" },
    })
    const touchFile = mock(async () => {})
    const diagnostics = mock(async () => diagnosticMap())
    LSP.touchFile = touchFile as typeof LSP.touchFile
    LSP.diagnostics = diagnostics as typeof LSP.diagnostics

    expect(await captureWriteDiagnosticsBefore()).toBeUndefined()
    expect(await collectWriteDiagnostics(filePath)).toEqual({ diagnostics: {}, output: "" })
    expect(touchFile).not.toHaveBeenCalled()
    expect(diagnostics).not.toHaveBeenCalled()
  })

  test("defaults to errors across the project when policy is absent", async () => {
    setConfig({})
    setDiagnostics(diagnosticMap())

    const result = await collectWriteDiagnostics(filePath)

    expect(result.output).toContain("file error")
    expect(result.output).toContain("project error")
    expect(result.output).not.toContain("file warning")
    expect(result.output).not.toContain("project warning")
  })

  test("fills a missing scope from the project compatibility default", async () => {
    setConfig({ lspDiagnostics: { severity: "warning" } })
    setDiagnostics(diagnosticMap())

    const result = await collectWriteDiagnostics(filePath)

    expect(result.output).toContain("file warning")
    expect(result.output).toContain("project warning")
  })

  test("fills a missing severity from the error compatibility default", async () => {
    setConfig({ lspDiagnostics: { scope: "project" } })
    setDiagnostics(diagnosticMap())

    const result = await collectWriteDiagnostics(filePath)

    expect(result.output).toContain("file error")
    expect(result.output).toContain("project error")
    expect(result.output).not.toContain("file warning")
    expect(result.output).not.toContain("project warning")
  })

  test("error severity excludes warnings", async () => {
    setConfig({ lspDiagnostics: { severity: "error", scope: "project" } })
    setDiagnostics(diagnosticMap())

    const result = await collectWriteDiagnostics(filePath)

    expect(result.output).toContain("file error")
    expect(result.output).toContain("project error")
    expect(result.output).not.toContain("file warning")
    expect(result.output).not.toContain("project warning")
  })

  test("warning severity includes errors and warnings", async () => {
    setConfig({ lspDiagnostics: { severity: "warning", scope: "project" } })
    setDiagnostics(diagnosticMap())

    const result = await collectWriteDiagnostics(filePath)

    expect(result.output).toContain("file error")
    expect(result.output).toContain("file warning")
    expect(result.output).toContain("project error")
    expect(result.output).toContain("project warning")
  })

  test("file scope excludes diagnostics from other files", async () => {
    setConfig({ lspDiagnostics: { severity: "warning", scope: "file" } })
    setDiagnostics(diagnosticMap())

    const result = await collectWriteDiagnostics(filePath)

    expect(result.output).toContain("file error")
    expect(result.output).toContain("file warning")
    expect(result.output).not.toContain("project error")
    expect(result.output).not.toContain("project warning")
  })

  test("file scope returns no output when the target file has no matching diagnostics", async () => {
    setConfig({ lspDiagnostics: { severity: "error", scope: "file" } })
    setDiagnostics({
      [filePath]: [diagnostic(0, 2, "file warning")],
      [otherFilePath]: [diagnostic(0, 1, "project error")],
    })

    expect((await collectWriteDiagnostics(filePath)).output).toBe("")
  })

  test("delta scope reports only filtered changes for the target file", async () => {
    setConfig({ lspDiagnostics: { severity: "warning", scope: "delta" } })
    const before = {
      [filePath]: [diagnostic(0, 1, "resolved error"), diagnostic(1, 2, "unchanged warning")],
      [otherFilePath]: [diagnostic(0, 1, "resolved project error")],
    }
    setDiagnostics({
      [filePath]: [diagnostic(1, 2, "unchanged warning"), diagnostic(2, 1, "new error")],
      [otherFilePath]: [diagnostic(1, 1, "new project error")],
    })

    const result = await collectWriteDiagnostics(filePath, { before })

    expect(result.delta).toEqual({
      added: [diagnostic(2, 1, "new error")],
      resolved: [diagnostic(0, 1, "resolved error")],
      unchanged: 1,
    })
    expect(result.output).toContain("new error")
    expect(result.output).toContain("resolved error")
    expect(result.output).not.toContain("project error")
  })

  test("delta scope filters warnings from added resolved and unchanged counts in error mode", async () => {
    setConfig({ lspDiagnostics: { severity: "error", scope: "delta" } })
    const before = {
      [filePath]: [diagnostic(0, 1, "unchanged error"), diagnostic(1, 2, "resolved warning")],
    }
    setDiagnostics({
      [filePath]: [diagnostic(0, 1, "unchanged error"), diagnostic(2, 2, "new warning")],
    })

    const result = await collectWriteDiagnostics(filePath, { before })

    expect(result.delta).toEqual({ added: [], resolved: [], unchanged: 1 })
    expect(result.output).not.toContain("warning")
  })

  test("delta scope falls back to file output when no before snapshot is available", async () => {
    setConfig({ lspDiagnostics: { severity: "warning", scope: "delta" } })
    setDiagnostics(diagnosticMap())

    const result = await collectWriteDiagnostics(filePath)

    expect(result.delta).toBeUndefined()
    expect(result.output).toContain("file error")
    expect(result.output).toContain("file warning")
    expect(result.output).not.toContain("project error")
  })
})

function setConfig(config: Partial<Config.Info>) {
  Config.current = mock(async () => config as Config.Info) as typeof Config.current
}

function setDiagnostics(value: Awaited<ReturnType<typeof LSP.diagnostics>>) {
  LSP.touchFile = mock(async () => {}) as typeof LSP.touchFile
  LSP.diagnostics = mock(async () => value) as typeof LSP.diagnostics
}

function diagnosticMap(): Awaited<ReturnType<typeof LSP.diagnostics>> {
  return {
    [filePath]: [diagnostic(0, 1, "file error"), diagnostic(1, 2, "file warning")],
    [otherFilePath]: [diagnostic(0, 1, "project error"), diagnostic(1, 2, "project warning")],
  }
}

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
