import { afterEach, describe, expect, mock, test } from "bun:test"
import { Config } from "../../src/config/config"
import { LSP } from "../../src/lsp"
import { collectWriteDiagnostics, writeDiagnosticsEnabled } from "../../src/tool/write-quality"

const originalConfigCurrent = Config.current
const originalTouchFile = LSP.touchFile
const originalDiagnostics = LSP.diagnostics

afterEach(() => {
  Config.current = originalConfigCurrent
  LSP.touchFile = originalTouchFile
  LSP.diagnostics = originalDiagnostics
})

describe("post-write LSP diagnostics", () => {
  test("skips every LSP call when post-write diagnostics are disabled", async () => {
    Config.current = mock(async () => ({ lspWriteDiagnostics: false }) as Config.Info) as typeof Config.current
    const touchFile = mock(async () => {})
    const diagnostics = mock(async () => ({}))
    LSP.touchFile = touchFile as typeof LSP.touchFile
    LSP.diagnostics = diagnostics as typeof LSP.diagnostics

    expect(await writeDiagnosticsEnabled()).toBe(false)
    expect(await collectWriteDiagnostics("/tmp/example.ts")).toEqual({ diagnostics: {}, output: "" })
    expect(touchFile).not.toHaveBeenCalled()
    expect(diagnostics).not.toHaveBeenCalled()
  })

  test("keeps post-write diagnostics enabled by default", async () => {
    Config.current = mock(async () => ({}) as Config.Info) as typeof Config.current
    const touchFile = mock(async () => {})
    const diagnostics = mock(async () => ({}))
    LSP.touchFile = touchFile as typeof LSP.touchFile
    LSP.diagnostics = diagnostics as typeof LSP.diagnostics

    expect(await writeDiagnosticsEnabled()).toBe(true)
    expect(await collectWriteDiagnostics("/tmp/example.ts")).toEqual({ diagnostics: {}, output: "" })
    expect(touchFile).toHaveBeenCalledTimes(1)
    expect(diagnostics).toHaveBeenCalledTimes(1)
  })
})
