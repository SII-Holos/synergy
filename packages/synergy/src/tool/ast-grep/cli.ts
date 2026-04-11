import { spawn } from "bun"
import { existsSync, realpathSync, statSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"
import type { AstGrepLanguage, CliMatch, SgResult } from "./types"
import { DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_MATCHES } from "./types"

export interface RunOptions {
  pattern: string
  lang: AstGrepLanguage
  paths?: string[]
  globs?: string[]
  rewrite?: string
  context?: number
  updateAll?: boolean
  cwd?: string
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
  const args = ["run", "-p", options.pattern, "--lang", options.lang, "--json=compact"]

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
  const timeout = DEFAULT_TIMEOUT_MS

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

  const timeoutPromise = new Promise<never>((_, reject) => {
    const id = setTimeout(() => {
      proc.kill()
      reject(new Error(`Search timeout after ${timeout}ms`))
    }, timeout)
    proc.exited.then(() => clearTimeout(id))
  })

  let stdout: string
  let stderr: string

  try {
    const stdoutStream = proc.stdout
    const stderrStream = proc.stderr
    if (typeof stdoutStream === "number" || typeof stderrStream === "number") {
      return {
        matches: [],
        totalMatches: 0,
        truncated: false,
        error: "Failed to capture output streams",
      }
    }
    stdout = await Promise.race([new Response(stdoutStream).text(), timeoutPromise])
    stderr = await new Response(stderrStream).text()
    await proc.exited
  } catch (e) {
    const error = e as Error
    if (error.message?.includes("timeout")) {
      return {
        matches: [],
        totalMatches: 0,
        truncated: true,
        truncatedReason: "timeout",
        error: error.message,
      }
    }
    return {
      matches: [],
      totalMatches: 0,
      truncated: false,
      error: `Failed to run ast-grep: ${error.message}`,
    }
  }

  // Handle no output
  if (!stdout.trim()) {
    if (stderr.includes("No files found")) {
      return { matches: [], totalMatches: 0, truncated: false }
    }
    if (stderr.trim()) {
      return { matches: [], totalMatches: 0, truncated: false, error: stderr.trim() }
    }
    return { matches: [], totalMatches: 0, truncated: false }
  }

  // Check if output is truncated
  const outputTruncated = stdout.length >= DEFAULT_MAX_OUTPUT_BYTES
  const outputToProcess = outputTruncated ? stdout.substring(0, DEFAULT_MAX_OUTPUT_BYTES) : stdout

  let matches: CliMatch[] = []
  try {
    matches = JSON.parse(outputToProcess) as CliMatch[]
  } catch {
    if (outputTruncated) {
      // Try to parse partial JSON
      try {
        const lastValidIndex = outputToProcess.lastIndexOf("}")
        if (lastValidIndex > 0) {
          const bracketIndex = outputToProcess.lastIndexOf("},", lastValidIndex)
          if (bracketIndex > 0) {
            const truncatedJson = outputToProcess.substring(0, bracketIndex + 1) + "]"
            matches = JSON.parse(truncatedJson) as CliMatch[]
          }
        }
      } catch {
        return {
          matches: [],
          totalMatches: 0,
          truncated: true,
          truncatedReason: "max_output_bytes",
          error: "Output too large and could not be parsed",
        }
      }
    } else {
      return { matches: [], totalMatches: 0, truncated: false }
    }
  }

  const totalMatches = matches.length
  const matchesTruncated = totalMatches > DEFAULT_MAX_MATCHES
  const finalMatches = matchesTruncated ? matches.slice(0, DEFAULT_MAX_MATCHES) : matches

  return {
    matches: finalMatches,
    totalMatches,
    truncated: outputTruncated || matchesTruncated,
    truncatedReason: outputTruncated ? "max_output_bytes" : matchesTruncated ? "max_matches" : undefined,
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
        ? `showing first ${result.matches.length} of ${result.totalMatches}`
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
