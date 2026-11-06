import { ToolLspSource } from "./lsp-source"
import { prettyDiagnostic } from "./diagnostic-format"
import { Filesystem } from "../util/filesystem"

type Diagnostic = ToolLspSource.Diagnostic

export interface DiagnosticDelta {
  added: Diagnostic[]
  resolved: Diagnostic[]
  unchanged: number
  errored?: boolean
}

function diagnosticKey(d: Diagnostic): string {
  const r = d.range
  return [
    r.start.line,
    r.start.character,
    r.end.line,
    r.end.character,
    d.severity ?? 1,
    d.code ?? "",
    d.message.replace(/\s+/g, " ").toLowerCase().trim(),
  ].join("::")
}

export function diffDiagnostics(
  before: ToolLspSource.DiagnosticsSnapshot | undefined,
  after: ToolLspSource.DiagnosticsSnapshot | undefined,
  filePath: string,
  include: (diagnostic: Diagnostic) => boolean = () => true,
): DiagnosticDelta {
  const normalizedPath = Filesystem.normalizePath(filePath)

  if (!before || !after) {
    return { added: [], resolved: [], unchanged: 0, errored: true }
  }

  const beforeForFile = (before[normalizedPath] ?? []).filter(include)
  const afterForFile = (after[normalizedPath] ?? []).filter(include)

  const beforeKeys = new Map<string, Diagnostic>()
  for (const d of beforeForFile) {
    beforeKeys.set(diagnosticKey(d), d)
  }

  const afterKeys = new Map<string, Diagnostic>()
  for (const d of afterForFile) {
    afterKeys.set(diagnosticKey(d), d)
  }

  const added: Diagnostic[] = []
  const resolved: Diagnostic[] = []
  let unchanged = 0

  for (const [key, d] of afterKeys) {
    if (beforeKeys.has(key)) {
      unchanged++
    } else {
      added.push(d)
    }
  }

  for (const [key, d] of beforeKeys) {
    if (!afterKeys.has(key)) {
      resolved.push(d)
    }
  }

  return { added, resolved, unchanged }
}

export function formatDiagnosticDelta(delta: DiagnosticDelta): string {
  if (delta.errored && delta.added.length === 0 && delta.resolved.length === 0 && delta.unchanged === 0) {
    return "\n<diagnostics_delta>\nNo diagnostics available (LSP may be disabled or timed out).\n</diagnostics_delta>\n"
  }

  if (delta.added.length === 0 && delta.resolved.length === 0 && delta.unchanged === 0) {
    return "\n<diagnostics_delta>\nNo diagnostics found.\n</diagnostics_delta>\n"
  }

  let output = "\n<diagnostics_delta>\n"

  if (delta.added.length > 0) {
    output += "New diagnostics introduced by this edit:\n"
    for (const d of delta.added) {
      output += `  - ${prettyDiagnostic(d)}\n`
    }
  } else {
    output += "No new diagnostics introduced by this edit.\n"
  }

  if (delta.resolved.length > 0) {
    output += "Diagnostics resolved by this edit:\n"
    for (const d of delta.resolved) {
      output += `  - ${prettyDiagnostic(d)}\n`
    }
  }

  if (delta.unchanged > 0) {
    output += `Pre-existing diagnostics: ${delta.unchanged} (unchanged)\n`
  }

  if (delta.errored) {
    output += "Note: some diagnostics may be unavailable due to LSP timeout or error.\n"
  }

  output += "</diagnostics_delta>\n"
  return output
}
