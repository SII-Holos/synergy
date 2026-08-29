import { Config } from "../config/config"
import { ToolLspSource } from "./lsp-source"
import { prettyDiagnostic } from "./diagnostic-format"
import { type DiagnosticDelta, diffDiagnostics, formatDiagnosticDelta } from "./diagnostics-delta"
import { Filesystem } from "../util/filesystem"

const MAX_DIAGNOSTICS_PER_FILE = 20
const MAX_PROJECT_DIAGNOSTICS_FILES = 5

type DiagnosticsPolicy = NonNullable<Config.Info["lspDiagnostics"]>
type ResolvedDiagnosticsPolicy = Required<DiagnosticsPolicy>

const DEFAULT_DIAGNOSTICS_POLICY: ResolvedDiagnosticsPolicy = {
  severity: "error",
  scope: "project",
}

export type WriteDiagnosticsSnapshot = ToolLspSource.DiagnosticsSnapshot

export async function captureWriteDiagnosticsBefore(): Promise<WriteDiagnosticsSnapshot | undefined> {
  const config = await Config.current()
  const policy = resolveDiagnosticsPolicy(config.lspDiagnostics)
  if (config.lspWriteDiagnostics === false || policy.scope !== "delta") return undefined
  return ToolLspSource.get()
    ?.diagnostics()
    .catch(() => undefined)
}

export async function collectWriteDiagnostics(
  filePath: string,
  options?: { before?: WriteDiagnosticsSnapshot },
): Promise<{
  diagnostics: WriteDiagnosticsSnapshot
  output: string
  delta?: DiagnosticDelta
}> {
  const config = await Config.current()
  if (config.lspWriteDiagnostics === false) return { diagnostics: {}, output: "" }

  const policy = resolveDiagnosticsPolicy(config.lspDiagnostics)
  const include = severityPredicate(policy.severity)

  const source = ToolLspSource.get()
  if (!source) return { diagnostics: {}, output: "" }

  await source.touchFile(filePath, true)
  const diagnostics = await source.diagnostics()

  if (policy.scope === "delta" && options?.before) {
    const delta = diffDiagnostics(options.before, diagnostics, filePath, include)
    return { diagnostics, output: formatDiagnosticDelta(delta), delta }
  }

  const scope = policy.scope === "project" ? "project" : "file"
  return { diagnostics, output: formatDiagnostics(diagnostics, filePath, policy.severity, scope) }
}

function resolveDiagnosticsPolicy(policy: DiagnosticsPolicy | undefined): ResolvedDiagnosticsPolicy {
  return { ...DEFAULT_DIAGNOSTICS_POLICY, ...policy }
}

function severityPredicate(
  severity: ResolvedDiagnosticsPolicy["severity"],
): (diagnostic: ToolLspSource.Diagnostic) => boolean {
  if (severity === "warning") return (diagnostic) => diagnostic.severity === 1 || diagnostic.severity === 2
  return (diagnostic) => diagnostic.severity === 1
}

function formatDiagnostics(
  diagnostics: WriteDiagnosticsSnapshot,
  filePath: string,
  severity: ResolvedDiagnosticsPolicy["severity"],
  scope: "file" | "project",
): string {
  const normalizedFilePath = Filesystem.normalizePath(filePath)
  const include = severityPredicate(severity)
  let output = ""
  let projectDiagnosticsCount = 0

  for (const [file, issues] of Object.entries(diagnostics)) {
    if (scope === "file" && file !== normalizedFilePath) continue

    const matching = issues.filter(include)
    if (matching.length === 0) continue
    const limited = matching.slice(0, MAX_DIAGNOSTICS_PER_FILE)
    const suffix =
      matching.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${matching.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""

    if (file === normalizedFilePath) {
      const label = severity === "warning" ? "errors or warnings" : "errors"
      output += `\nThis file has ${label}, please fix\n<file_diagnostics>\n${limited.map(prettyDiagnostic).join("\n")}${suffix}\n</file_diagnostics>\n`
      continue
    }

    if (projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
    projectDiagnosticsCount++
    output += `\n<project_diagnostics>\n${file}\n${limited.map(prettyDiagnostic).join("\n")}${suffix}\n</project_diagnostics>\n`
  }

  return output
}
