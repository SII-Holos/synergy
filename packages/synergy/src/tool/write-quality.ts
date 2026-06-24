import { LSP } from "../lsp"
import { Filesystem } from "../util/filesystem"
import { type DiagnosticDelta, diffDiagnostics, formatDiagnosticDelta } from "../lsp/diagnostics-delta"

const MAX_DIAGNOSTICS_PER_FILE = 20
const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export async function collectWriteDiagnostics(
  filePath: string,
  options?: { before?: Awaited<ReturnType<typeof LSP.diagnostics>> },
): Promise<{
  diagnostics: Awaited<ReturnType<typeof LSP.diagnostics>>
  output: string
  delta?: DiagnosticDelta
}> {
  await LSP.touchFile(filePath, true)
  const diagnostics = await LSP.diagnostics()
  const before = options?.before

  if (before) {
    const delta = diffDiagnostics(before, diagnostics, filePath)
    return { diagnostics, output: formatDiagnosticDelta(delta), delta }
  }

  return { diagnostics, output: formatDiagnostics(diagnostics, filePath) }
}

function formatDiagnostics(diagnostics: Awaited<ReturnType<typeof LSP.diagnostics>>, filePath: string): string {
  const normalizedFilePath = Filesystem.normalizePath(filePath)
  let output = ""
  let projectDiagnosticsCount = 0

  for (const [file, issues] of Object.entries(diagnostics)) {
    const errors = issues.filter((item) => item.severity === 1)
    if (errors.length === 0) continue
    const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
    const suffix =
      errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""

    if (file === normalizedFilePath) {
      output += `\nThis file has errors, please fix\n<file_diagnostics>\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</file_diagnostics>\n`
      continue
    }

    if (projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
    projectDiagnosticsCount++
    output += `\n<project_diagnostics>\n${file}\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</project_diagnostics>\n`
  }

  return output
}
