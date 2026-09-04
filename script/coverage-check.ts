#!/usr/bin/env bun

/**
 * Coverage gate. Runs each package's coverage command from the manifest,
 * parses lcov.info, applies file-level exemptions, and enforces per-package
 * line/function thresholds (the only metrics Bun 1.3.14 exposes).
 *
 * Source files that never appear in lcov (never loaded by any test) count as
 * 0% so an uncovered file cannot silently vanish from the numbers.
 *
 * Modes:
 *   bun script/coverage-check.ts                 run commands, evaluate, report
 *   bun script/coverage-check.ts --validate      manifest self-consistency only
 *   bun script/coverage-check.ts --json          emit machine-readable summary
 */

import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"

const REPO_ROOT = path.resolve(import.meta.dir, "..")

const SOURCE_GLOBS = ["src/**/*.ts", "src/**/*.tsx"]
const EXEMPT_MAX_SHARE = 0.25
export interface Thresholds {
  lines: number
  functions: number
}

export interface Exemption {
  glob: string
  reason: string
}

export interface PackageCoverageConfig {
  command: string
  lcov: string
  thresholds: Thresholds
  exempt: Exemption[]
  /** Per-package cap on the share of source files a single exemption glob may cover. */
  maxExemptShare?: number
}

export interface CoverageManifest {
  packages: Record<string, PackageCoverageConfig>
}

export interface LcovRecord {
  file: string
  linesFound: number
  linesHit: number
  functionsFound: number
  functionsHit: number
  counts: Map<number, number>
}

export interface PackageVerdict {
  package: string
  command: string
  universe: number
  measured: number
  missing: number
  exempted: number
  linesPct: number
  functionsPct: number
  thresholds: Thresholds
  passed: boolean
  uncovered: Array<{ file: string; lines: number[] }>
  errors: string[]
}

export function parseLcov(source: string): LcovRecord[] {
  const records: LcovRecord[] = []
  let current: LcovRecord | null = null
  for (const line of source.split("\n")) {
    if (line === "end_of_record") {
      if (current) records.push(current)
      current = null
      continue
    }
    if (line.startsWith("SF:")) {
      current = {
        file: line.slice(3),
        linesFound: 0,
        linesHit: 0,
        functionsFound: 0,
        functionsHit: 0,
        counts: new Map(),
      }
    } else if (current) {
      if (line.startsWith("DA:")) {
        const [lineNo, count] = line.slice(3).split(",")
        current.counts.set(Number(lineNo), Number(count))
      } else if (line.startsWith("LF:")) current.linesFound = Number(line.slice(3))
      else if (line.startsWith("LH:")) current.linesHit = Number(line.slice(3))
      else if (line.startsWith("FNF:")) current.functionsFound = Number(line.slice(4))
      else if (line.startsWith("FNH:")) current.functionsHit = Number(line.slice(4))
    }
  }
  return records
}

export function mergeLcov(batches: LcovRecord[][]): LcovRecord[] {
  const byFile = new Map<string, LcovRecord>()
  for (const records of batches) {
    for (const record of records) {
      const existing = byFile.get(record.file)
      if (!existing) {
        byFile.set(record.file, {
          file: record.file,
          linesFound: record.linesFound,
          linesHit: record.linesHit,
          functionsFound: record.functionsFound,
          functionsHit: record.functionsHit,
          counts: new Map(record.counts),
        })
        continue
      }
      // Union semantics: every batch reports the whole file (Bun overwrites
      // lcov per invocation, so batches never split one file's lines). Take
      // maxima for file-level totals and per-line counts. Bun emits no FN
      // records, so function totals use maxima as the closest union.
      existing.linesFound = Math.max(existing.linesFound, record.linesFound)
      existing.functionsFound = Math.max(existing.functionsFound, record.functionsFound)
      existing.functionsHit = Math.max(existing.functionsHit, record.functionsHit)
      for (const [lineNo, count] of record.counts) {
        existing.counts.set(lineNo, Math.max(existing.counts.get(lineNo) ?? 0, count))
      }
      existing.linesHit = [...existing.counts.values()].filter((count) => count > 0).length
    }
  }
  return [...byFile.values()].sort((left, right) => left.file.localeCompare(right.file))
}

export async function loadManifest(root: string = REPO_ROOT): Promise<CoverageManifest> {
  const raw = await readFile(path.join(root, "script", "coverage-exempt.json"), "utf8")
  return JSON.parse(raw) as CoverageManifest
}

async function walkFiles(dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === "node_modules" || entry.name === "coverage" || entry.name === "dist") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(full, out)
    } else {
      out.push(full)
    }
  }
}

export async function sourceUniverse(packageRoot: string, globs: string[]): Promise<string[]> {
  const root = path.join(packageRoot, "src")
  const collected: string[] = []
  await walkFiles(root, collected)
  const files = collected
    .map((full) => path.relative(packageRoot, full))
    .filter((rel) => globs.some((pattern) => new Bun.Glob(pattern).match(rel)))
  return files.sort()
}

export function matchesExempt(file: string, exempt: Exemption[]): Exemption | null {
  for (const entry of exempt) {
    const glob = new Bun.Glob(entry.glob)
    if (glob.match(file)) return entry
  }
  return null
}

export function evaluatePackage(
  name: string,
  config: PackageCoverageConfig,
  universe: string[],
  lcov: LcovRecord[],
): PackageVerdict {
  const errors: string[] = []
  const byFile = new Map(lcov.map((record) => [record.file, record]))
  let linesFound = 0
  let linesHit = 0
  let functionsFound = 0
  let functionsHit = 0
  let measured = 0
  let missing = 0
  let exempted = 0
  const uncovered: Array<{ file: string; lines: number[] }> = []

  for (const file of universe) {
    const exemption = matchesExempt(file, config.exempt)
    if (exemption) {
      exempted++
      continue
    }
    const record = byFile.get(file)
    if (!record) {
      missing++
      uncovered.push({ file, lines: [] })
      continue
    }
    measured++
    linesFound += record.linesFound
    linesHit += record.linesHit
    functionsFound += record.functionsFound
    functionsHit += record.functionsHit
    const zeroLines: number[] = []
    for (const [lineNo, count] of record.counts) {
      if (count === 0) zeroLines.push(lineNo)
    }
    if (zeroLines.length > 0) uncovered.push({ file, lines: zeroLines })
  }

  const linesPct = linesFound === 0 ? 100 : (linesHit / linesFound) * 100
  const functionsPct = functionsFound === 0 ? 100 : (functionsHit / functionsFound) * 100
  const passed =
    missing === 0 &&
    linesPct >= config.thresholds.lines &&
    functionsPct >= config.thresholds.functions &&
    errors.length === 0
  return {
    package: name,
    command: config.command,
    universe: universe.length,
    measured,
    missing,
    exempted,
    linesPct,
    functionsPct,
    thresholds: config.thresholds,
    passed,
    uncovered: uncovered
      .sort((left, right) => {
        const leftMissing = left.lines.length === 0 ? 1 : 0
        const rightMissing = right.lines.length === 0 ? 1 : 0
        // Never-loaded files are the actionable failures: show them first and
        // never let the cap slice them away.
        return rightMissing - leftMissing || right.lines.length - left.lines.length
      })
      .slice(0, 50),
    errors,
  }
}

export async function validateManifest(manifest: CoverageManifest, root: string = REPO_ROOT): Promise<string[]> {
  const errors: string[] = []
  for (const [name, config] of Object.entries(manifest.packages)) {
    const packageRoot = path.join(root, name)
    if (!config.thresholds || config.thresholds.lines < 0 || config.thresholds.functions < 0) {
      errors.push(`${name}: thresholds missing or negative`)
    }
    if (!config.command) errors.push(`${name}: missing command`)
    const universe = await sourceUniverse(packageRoot, SOURCE_GLOBS)
    const seenFiles = new Set<string>()
    for (const entry of config.exempt ?? []) {
      if (!entry.reason || !entry.reason.trim()) {
        errors.push(`${name}: exemption '${entry.glob}' has no reason`)
        continue
      }
      const matched = universe.filter((file) => matchesExempt(file, [entry]))
      if (matched.length === 0) {
        errors.push(`${name}: exemption '${entry.glob}' matches no source files`)
        continue
      }
      for (const file of matched) {
        if (seenFiles.has(file)) errors.push(`${name}: '${file}' matches multiple exemptions`)
        seenFiles.add(file)
      }
      const shareLimit = config.maxExemptShare ?? EXEMPT_MAX_SHARE
      if (universe.length > 0 && matched.length / universe.length > shareLimit) {
        errors.push(
          `${name}: exemption '${entry.glob}' covers ${matched.length}/${universe.length} files (>${(shareLimit * 100).toFixed(0)}% — too broad; split into narrower entries)`,
        )
      }
    }
  }
  return errors
}

async function collectLcovFiles(packageRoot: string, relPath: string): Promise<string[]> {
  const base = path.join(packageRoot, path.dirname(relPath))
  // Sharded orchestrators (app, ui, synergy coverage-run) write
  // coverage/shards/<n>/lcov.info.
  // Only numeric shard directories count as shards so stray probe or cache
  // directories can never masquerade as coverage batches.
  const shardRoot = path.join(base, "shards")
  const shardNames = await readdir(shardRoot, { withFileTypes: true }).catch(() => [])
  const shards: string[] = []
  for (const entry of shardNames) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const candidate = path.join(shardRoot, entry.name, "lcov.info")
    const exists = await stat(candidate)
      .then((info) => info.isFile())
      .catch(() => false)
    if (exists) shards.push(candidate)
  }
  if (shards.length > 0) return shards.sort()
  const direct = path.join(packageRoot, relPath)
  const exists = await stat(direct)
    .then((info) => info.isFile())
    .catch(() => false)
  return exists ? [direct] : []
}

/**
 * Pull the actionable failure lines out of a failing command's output so the
 * gate names the real culprit even when the full detail gets truncated.
 *
 * bun test prints failures as "(fail) <suite> > <name>"; the sharded
 * orchestrators print "test batches failed: shard N (exit M)"; vite lib
 * builds print "externalized for browser compatibility" followed by the
 * offending module ids. When none of those appear the failure is
 * process-level (crash/kill), so fall back to the output tail.
 */
export function extractFailureSignals(detail: string, maxFails = 30): string[] {
  const lines = detail.split("\n")
  const signals: string[] = []
  let fails = 0
  let externalizedBlock = false
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index]!.trim()
    if (trimmed.startsWith("(fail) ")) {
      if (fails < maxFails) signals.push(lines[index]!)
      fails++
    } else if (trimmed.startsWith("error: ")) {
      // Keep the error line plus its immediate context (assertion diff,
      // stack frame, or next failing test) so the gate shows the actual
      // expectation mismatch, not just the error kind.
      const block = [lines[index]!]
      for (let next = index + 1; next < lines.length && block.length < 15; next++) {
        const nextTrimmed = lines[next]!.trim()
        if (nextTrimmed === "") break
        if (nextTrimmed.startsWith("(pass) ") || nextTrimmed.startsWith("(fail) ")) break
        block.push(lines[next]!)
      }
      signals.push(block.join("\n"))
    } else if (trimmed.startsWith("test batches failed")) {
      signals.push(lines[index]!)
    } else if (trimmed.includes("externalized for browser compatibility") && !externalizedBlock) {
      externalizedBlock = true
      const block = [lines[index]!]
      for (let next = index + 1; next < lines.length && block.length < 20; next++) {
        if (lines[next]!.trim() === "") break
        block.push(lines[next]!)
      }
      signals.push(block.join("\n"))
    }
  }
  if (fails > maxFails) signals.push(`… and ${fails - maxFails} more failing tests`)
  if (signals.length === 0) return lines.slice(-25)
  return signals
}

async function runPackage(
  name: string,
  config: PackageCoverageConfig,
  root: string,
): Promise<{ lcov: LcovRecord[]; universe: string[] }> {
  const packageRoot = path.join(root, name)
  // Force a deterministic locale: coverage numbers must not vary with the
  // developer's LANG (e.g. zh_CN `ps -o lstart` output breaks process-lock
  // identity parsing in suites that shell out).
  const output = await $`sh -c ${config.command}`
    .cwd(packageRoot)
    .env({ ...process.env, LC_ALL: "C" })
    .nothrow()
    .quiet()
  if (output.exitCode !== 0) {
    // A failing test batch used to surface only as phantom "missing" files
    // (the shard orchestrator aborted every remaining batch). Report the
    // underlying failure with its output so the gate names the real culprit.
    // bun test prints its failure summary at the END of the stream, so keep
    // a small head prefix for the command banner plus the tail when the
    // output exceeds the cap instead of truncating from the front.
    const stderr = output.stderr.toString().trim()
    const stdout = output.stdout.toString().trim()
    const detail = stdout ? `${stderr}\n--- stdout ---\n${stdout}` : stderr
    const signals = extractFailureSignals(detail)
    const MAX = 30_000
    const HEAD = 20_000
    const shown = detail.length > MAX ? `${detail.slice(0, HEAD)}\n…\n${detail.slice(-(MAX - HEAD))}` : detail
    const prefix = signals.length > 0 ? `\n--- failure signals ---\n${signals.join("\n")}\n` : ""
    throw new Error(`${name}: coverage command exited ${output.exitCode}${prefix}\n${shown}`)
  }
  // Sharded orchestrators (app, ui, synergy coverage-run) write one lcov per
  // batch under coverage/shards/; merge them when present, otherwise read the
  // single canonical file.
  const lcovFiles = (await collectLcovFiles(packageRoot, config.lcov)).sort()
  if (lcovFiles.length === 0) {
    const direct = path.join(packageRoot, config.lcov)
    const exists = await stat(direct)
      .then((info) => info.isFile())
      .catch(() => false)
    if (exists) lcovFiles.push(direct)
  }
  if (lcovFiles.length === 0) throw new Error(`${name}: no lcov output under ${config.lcov}`)
  const batches = await Promise.all(
    lcovFiles.map(async (file) => parseLcov(await readFile(file, "utf8").catch(() => ""))),
  )
  const universe = await sourceUniverse(packageRoot, SOURCE_GLOBS)
  return { lcov: mergeLcov(batches), universe }
}

export async function runCoverageCheck(
  options: { validateOnly?: boolean; root?: string; json?: boolean } = {},
): Promise<{ verdicts: PackageVerdict[]; errors: string[]; passed: boolean }> {
  const root = options.root ?? REPO_ROOT
  const manifest = await loadManifest(root)
  const errors = await validateManifest(manifest, root)
  if (options.validateOnly || errors.length > 0) {
    return { verdicts: [], errors, passed: errors.length === 0 }
  }
  const verdicts: PackageVerdict[] = []
  for (const [name, config] of Object.entries(manifest.packages)) {
    try {
      const { lcov, universe } = await runPackage(name, config, root)
      verdicts.push(evaluatePackage(name, config, universe, lcov))
    } catch (error) {
      verdicts.push({
        package: name,
        command: config.command,
        universe: 0,
        measured: 0,
        missing: 0,
        exempted: 0,
        linesPct: 0,
        functionsPct: 0,
        thresholds: config.thresholds,
        passed: false,
        uncovered: [],
        errors: [error instanceof Error ? error.message : String(error)],
      })
    }
  }
  const passed = verdicts.every((verdict) => verdict.passed)
  return { verdicts, errors, passed }
}

function fmt(pct: number): string {
  return `${pct.toFixed(1)}%`
}

if (import.meta.main) {
  const validateOnly = process.argv.includes("--validate")
  const asJson = process.argv.includes("--json")
  const result = await runCoverageCheck({ validateOnly, json: asJson })
  if (asJson) {
    console.log(JSON.stringify({ passed: result.passed, errors: result.errors, verdicts: result.verdicts }, null, 2))
  } else {
    for (const verdict of result.verdicts) {
      const status = verdict.passed ? "PASS" : "FAIL"
      console.log(
        `${status} ${verdict.package}: lines ${fmt(verdict.linesPct)}/${verdict.thresholds.lines}% functions ${fmt(verdict.functionsPct)}/${verdict.thresholds.functions}% (measured ${verdict.measured}, missing ${verdict.missing}, exempted ${verdict.exempted})`,
      )
      for (const error of verdict.errors) console.error(`- ${error}`)
      if (!verdict.passed) {
        for (const entry of verdict.uncovered) {
          console.error(`  ${entry.file}${entry.lines.length > 0 ? `:${entry.lines.join(",")}` : " (never loaded)"}`)
        }
      }
    }
    for (const error of result.errors) console.error(`- ${error}`)
    if (!result.passed || result.errors.length > 0) {
      console.error("Coverage gate failed.")
      process.exit(1)
    }
    console.log("Coverage gate passed.")
  }
}
