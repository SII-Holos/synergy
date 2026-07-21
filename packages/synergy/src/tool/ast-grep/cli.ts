import { spawn } from "bun"
import { existsSync, realpathSync, statSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"
import type { AstGrepLanguage, CliMatch, SgResult } from "./types"
import { DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_MATCHES } from "./types"
import { ProcessOutput } from "../../process/output"

export interface RunOptions {
  pattern: string
  lang: AstGrepLanguage
  paths?: string[]
  globs?: string[]
  rewrite?: string
  context?: number
  updateAll?: boolean
  cwd?: string
  signal?: AbortSignal
}

function isValidBinary(filePath: string): boolean {
  try {
    return statSync(filePath).size > 10000
  } catch {
    return false
  }
}

const PLATFORM_PACKAGES: Record<string, string> = {
  "darwin-arm64": "@ast-grep/cli-darwin-arm64",
  "darwin-x64": "@ast-grep/cli-darwin-x64",
  "linux-arm64": "@ast-grep/cli-linux-arm64-gnu",
  "linux-x64": "@ast-grep/cli-linux-x64-gnu",
  "win32-x64": "@ast-grep/cli-win32-x64-msvc",
}

function findSgCliPath(): string | null {
  const platformKey = `${process.platform}-${process.arch}`
  const pkgName = PLATFORM_PACKAGES[platformKey]
  const npmBinaryName = process.platform === "win32" ? "ast-grep.exe" : "ast-grep"

  // Check for packaged binary next to compiled executable (global install via npm)
  try {
    const execDir = path.dirname(realpathSync(process.execPath))
    const packagedPath = path.join(execDir, npmBinaryName)
    if (existsSync(packagedPath) && isValidBinary(packagedPath)) {
      return packagedPath
    }
  } catch {}

  // Check in synergy's own node_modules (bundled with the package)
  // The npm package uses "ast-grep" as binary name
  if (pkgName) {
    const thisDir = path.dirname(fileURLToPath(import.meta.url))
    const synergyRoot = path.resolve(thisDir, "../../..")
    const bundledPaths = [
      path.join(synergyRoot, "node_modules", pkgName, npmBinaryName),
      path.join(synergyRoot, "node_modules", "@ast-grep", "cli", npmBinaryName),
    ]

    for (const p of bundledPaths) {
      if (existsSync(p) && isValidBinary(p)) {
        return p
      }
    }
  }

  // Check homebrew/cargo installed "sg" binary
  const sgBinaryName = process.platform === "win32" ? "sg.exe" : "sg"

  // Check homebrew paths on macOS
  if (process.platform === "darwin") {
    const homebrewPaths = ["/opt/homebrew/bin/sg", "/usr/local/bin/sg"]
    for (const p of homebrewPaths) {
      if (existsSync(p) && isValidBinary(p)) {
        return p
      }
    }
  }

  // Check common Linux paths
  if (process.platform === "linux") {
    const linuxPaths = ["/usr/local/bin/sg", "/usr/bin/sg"]
    for (const p of linuxPaths) {
      if (existsSync(p) && isValidBinary(p)) {
        return p
      }
    }
  }

  // Try user's project node_modules as fallback
  if (pkgName) {
    const userPaths = [
      path.join(process.cwd(), "node_modules", pkgName, npmBinaryName),
      path.join(process.cwd(), "node_modules", "@ast-grep", "cli", npmBinaryName),
      path.join(process.cwd(), "node_modules", pkgName, sgBinaryName),
      path.join(process.cwd(), "node_modules", "@ast-grep", "cli", sgBinaryName),
    ]

    for (const p of userPaths) {
      if (existsSync(p) && isValidBinary(p)) {
        return p
      }
    }
  }

  // Fallback to hoping it's in PATH
  return null
}

let cachedCliPath: string | null = null

function getSgCliPath(): string {
  if (cachedCliPath !== null) {
    return cachedCliPath
  }

  const foundPath = findSgCliPath()
  if (foundPath) {
    cachedCliPath = foundPath
    return foundPath
  }

  // Fall back to "sg" and hope it's in PATH
  return "sg"
}

export async function runSg(options: RunOptions): Promise<SgResult> {
  const args = ["run", "-p", options.pattern, "--lang", options.lang, "--json=stream"]

  if (options.rewrite) {
    args.push("-r", options.rewrite)
    if (options.updateAll) {
      args.push("--update-all")
    }
  }

  if (options.context && options.context > 0) {
    args.push("-C", String(options.context))
  }

  if (options.globs) {
    for (const glob of options.globs) {
      args.push("--globs", glob)
    }
  }

  const paths = options.paths && options.paths.length > 0 ? options.paths : ["."]
  args.push(...paths)

  const cliPath = getSgCliPath()
  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal

  let proc: ReturnType<typeof spawn>
  try {
    proc = spawn([cliPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: options.cwd,
    })
  } catch (e) {
    const error = e as Error
    if (error.message?.includes("ENOENT") || error.message?.includes("not found")) {
      return {
        matches: [],
        totalMatches: 0,
        truncated: false,
        error:
          `ast-grep CLI binary not found.\n\n` +
          `Install options:\n` +
          `  brew install ast-grep\n` +
          `  cargo install ast-grep --locked\n` +
          `  bun add -D @ast-grep/cli`,
      }
    }
    return {
      matches: [],
      totalMatches: 0,
      truncated: false,
      error: `Failed to spawn ast-grep: ${error.message}`,
    }
  }

  const stdoutStream = proc.stdout
  const stderrStream = proc.stderr
  if (!stdoutStream || !stderrStream || typeof stdoutStream === "number" || typeof stderrStream === "number") {
    await ProcessOutput.terminate(proc)
    return {
      matches: [],
      totalMatches: 0,
      truncated: false,
      error: "Failed to capture output streams",
    }
  }

  const stderrPromise = ProcessOutput.drainText(stderrStream)
  const matches: CliMatch[] = []
  let totalMatches = 0
  let stoppedEarly = false
  let reachedEnd = false
  let truncatedReason: SgResult["truncatedReason"]
  let failure: Error | undefined
  let abortReason: unknown

  try {
    for await (const line of ProcessOutput.lines(stdoutStream, {
      maxRecordBytes: 256 * 1024,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      signal,
    })) {
      if (!line) continue
      const match = JSON.parse(line) as CliMatch
      totalMatches++
      if (matches.length < DEFAULT_MAX_MATCHES) {
        matches.push(match)
        continue
      }
      truncatedReason = "max_matches"
      stoppedEarly = true
      break
    }
    reachedEnd = !stoppedEarly
  } catch (error) {
    stoppedEarly = true
    if (options.signal?.aborted) {
      abortReason = options.signal.reason ?? new DOMException("Aborted", "AbortError")
    } else if (timeoutSignal.aborted) {
      truncatedReason = "timeout"
    } else if (error instanceof ProcessOutput.LimitError) {
      truncatedReason = "max_output_bytes"
    } else {
      failure = error instanceof Error ? error : new Error(String(error))
    }
  } finally {
    if (!reachedEnd) await ProcessOutput.terminate(proc)
  }

  const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise])
  if (abortReason) throw abortReason
  if (failure) {
    return {
      matches,
      totalMatches,
      truncated: false,
      error: `Failed to run ast-grep: ${failure.message}`,
    }
  }
  if (truncatedReason === "timeout" && matches.length === 0) {
    return {
      matches,
      totalMatches,
      truncated: true,
      truncatedReason,
      error: `Search timeout after ${DEFAULT_TIMEOUT_MS}ms`,
    }
  }
  if (exitCode !== 0 && exitCode !== 1 && !truncatedReason) {
    return {
      matches,
      totalMatches,
      truncated: false,
      error: stderr.text.trim() || `ast-grep exited with code ${exitCode}`,
    }
  }
  return {
    matches,
    totalMatches,
    truncated: truncatedReason !== undefined,
    truncatedReason,
  }
}

export function formatSearchResult(result: SgResult): string {
  if (result.error) {
    return `Error: ${result.error}`
  }

  if (result.matches.length === 0) {
    return "No matches found"
  }

  const lines: string[] = []

  if (result.truncated) {
    const reason =
      result.truncatedReason === "max_matches"
        ? `showing first ${result.matches.length} of at least ${result.totalMatches}`
        : result.truncatedReason === "max_output_bytes"
          ? "output exceeded 1MB limit"
          : "search timed out"
    lines.push(`Warning: Results truncated (${reason})\n`)
  }

  lines.push(`Found ${result.matches.length} match(es):\n`)

  for (const match of result.matches) {
    const loc = `${match.file}:${match.range.start.line + 1}:${match.range.start.column + 1}`
    lines.push(loc)
    lines.push(`  ${match.lines.trim()}`)
    lines.push("")
  }

  return lines.join("\n")
}
