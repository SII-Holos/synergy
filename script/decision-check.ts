#!/usr/bin/env bun

/**
 * Decision-record gate: path encoding, in-file format, and the archive seal.
 *
 * Modes:
 *   bun script/decision-check.ts            check every record + archive seal
 *   bun script/decision-check.ts --staged   check git-staged decision files + archive seal
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"

const REPO_ROOT = path.resolve(import.meta.dir, "..")

const LIFECYCLES = new Set(["proposed", "implemented", "rejected", "archived"])
const CLASSES = new Set(["feature", "bug-fix", "simplification", "architecture", "process", "testing"])

const REQUIRED_SECTIONS: Record<string, string[]> = {
  proposed: ["## Problem", "## Proposal", "## Alternatives considered", "## Acceptance criteria", "## Risks"],
  implemented: ["## Problem", "## Decision", "## Alternatives considered", "## Consequences"],
  rejected: ["## Problem", "## Proposal", "## Alternatives considered", "## Acceptance criteria", "## Risks"],
}

const FORBIDDEN_SECTIONS: Record<string, string[]> = {
  proposed: [],
  implemented: ["## Proposal", "## Acceptance criteria"],
  rejected: [],
}

const FILENAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/

export interface DecisionCheckOptions {
  staged?: boolean
  root?: string
  cwd?: string
}

export interface DecisionCheckResult {
  errors: string[]
}

function relative(file: string, cwd: string) {
  return path.relative(cwd, file) || "."
}

function decisionsDir(root: string) {
  return path.join(root, "docs", "decisions")
}

async function stagedFiles(root: string, cwd: string): Promise<string[]> {
  const result = await $`git diff --cached --name-only --diff-filter=ACMR`.cwd(cwd).quiet()
  const decisions = path.relative(cwd, decisionsDir(root))
  return result
    .text()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      // Only records at {lifecycle}/{class}/yyyy-mm-dd-topic-title.md are
      // staged-checked; docs/decisions/README.md is not a record.
      if (!line.startsWith(decisions) || !line.endsWith(".md")) return false
      const parts = line.slice(decisions.length).replace(/^\/+/, "").split("/")
      return parts.length === 3
    })
    .map((line) => path.join(cwd, line))
}

async function collectRecords(root: string): Promise<string[]> {
  const base = decisionsDir(root)
  const files: string[] = []
  for (const lifecycle of ["proposed", "implemented", "rejected", "archived"]) {
    const dir = path.join(base, lifecycle)
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      for (const file of await readdir(path.join(dir, entry.name))) {
        if (file.endsWith(".md")) files.push(path.join(dir, entry.name, file))
      }
    }
  }
  return files.sort()
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

export function classifyPath(file: string, base: string): { lifecycle: string; classDir: string } | null {
  const rel = path.relative(base, file)
  const parts = rel.split(path.sep)
  if (parts.length !== 3) return null
  return { lifecycle: parts[0]!, classDir: parts[1]! }
}

export function checkRecord(file: string, base: string, cwd: string): string[] {
  const errors: string[] = []
  const label = relative(file, cwd)
  const info = classifyPath(file, base)
  if (!info) {
    errors.push(`${label}: record must live at {lifecycle}/{class}/yyyy-mm-dd-topic-title.md`)
    return errors
  }
  const { lifecycle, classDir } = info
  if (!LIFECYCLES.has(lifecycle)) errors.push(`${label}: unknown lifecycle folder '${lifecycle}'`)
  if (!CLASSES.has(classDir)) errors.push(`${label}: unknown class folder '${classDir}'`)
  if (!FILENAME.test(path.basename(file))) errors.push(`${label}: filename must be yyyy-mm-dd-topic-title.md`)

  const source = (() => {
    try {
      return readFileSync(file, "utf8")
    } catch {
      errors.push(`${label}: unreadable record`)
      return ""
    }
  })()
  if (!source) return errors

  const lines = source.split("\n")
  const h1 = lines[0] ?? ""
  if (!h1.startsWith("# Decision Record: ")) {
    errors.push(`${label}: first line must be '# Decision Record: <title>'`)
  }
  const statusLine = lines[2] ?? ""
  const statusMatch = statusLine.match(/^Status:\s*(.+)$/)
  if (!statusMatch) {
    errors.push(`${label}: third line must be 'Status: <status>'`)
  } else {
    const status = statusMatch[1]!.trim()
    const expectedLifecycle = lifecycle === "archived" ? "implemented" : lifecycle
    if (lifecycle === "rejected") {
      if (!status.startsWith("rejected — ") && !status.startsWith("rejected -- ")) {
        errors.push(`${label}: rejected records need 'Status: rejected — <one-line reason>'`)
      }
    } else if (status !== expectedLifecycle) {
      errors.push(`${label}: Status '${status}' must equal lifecycle folder '${expectedLifecycle}'`)
    }
  }

  const headingSet = new Set(
    source
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.trim()),
  )
  for (const section of REQUIRED_SECTIONS[lifecycle] ?? []) {
    if (!headingSet.has(section)) errors.push(`${label}: missing '${section}' section`)
  }
  for (const section of FORBIDDEN_SECTIONS[lifecycle] ?? []) {
    if (headingSet.has(section)) errors.push(`${label}: '${section}' is not allowed in a ${lifecycle} record`)
  }
  if (lifecycle === "implemented" && !headingSet.has("## Alternatives considered")) {
    errors.push(`${label}: '## Alternatives considered' is mandatory`)
  }
  return errors
}

export async function checkArchiveSeal(root: string, cwd: string): Promise<string[]> {
  const errors: string[] = []
  const manifestPath = path.join(decisionsDir(root), "archived", "manifest.json")
  const manifestRaw = await readFile(manifestPath, "utf8").catch(() => null)
  if (manifestRaw === null) {
    errors.push(`${relative(manifestPath, cwd)}: archive manifest missing`)
    return errors
  }
  let manifest: { files?: Record<string, string> } = {}
  try {
    manifest = JSON.parse(manifestRaw) as { files?: Record<string, string> }
  } catch {
    errors.push(`${relative(manifestPath, cwd)}: invalid JSON`)
    return errors
  }
  const sealed = new Map(Object.entries(manifest.files ?? {}))
  const archivedDir = path.join(decisionsDir(root), "archived")
  const records: string[] = []
  for (const entry of await readdir(archivedDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    for (const file of await readdir(path.join(archivedDir, entry.name))) {
      if (file.endsWith(".md")) records.push(path.join(archivedDir, entry.name, file))
    }
  }
  const seen = new Set<string>()
  for (const record of records) {
    const key = path.relative(decisionsDir(root), record)
    seen.add(key)
    const expected = sealed.get(key)
    const actual = sha256(await readFile(record, "utf8"))
    if (!expected) {
      errors.push(`${relative(record, cwd)}: archived record is not sealed — add its sha256 to archived/manifest.json`)
    } else if (expected !== actual) {
      errors.push(`${relative(record, cwd)}: archive seal mismatch (archived records are frozen)`)
    }
  }
  for (const key of sealed.keys()) {
    if (!seen.has(key)) {
      errors.push(`${relative(decisionsDir(root), cwd)}/${key}: manifest entry has no matching file`)
    }
  }
  return errors
}

export async function runDecisionCheck(options: DecisionCheckOptions = {}): Promise<DecisionCheckResult> {
  const root = options.root ?? REPO_ROOT
  const cwd = options.cwd ?? root
  const errors: string[] = []
  const files = options.staged ? await stagedFiles(root, cwd) : await collectRecords(root)
  for (const file of files) {
    errors.push(...checkRecord(file, decisionsDir(root), cwd))
  }
  if (!options.staged || files.length > 0) {
    errors.push(...(await checkArchiveSeal(root, cwd)))
  }
  return { errors }
}

if (import.meta.main) {
  const staged = process.argv.includes("--staged")
  const result = await runDecisionCheck({ staged })
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`- ${error}`)
    console.error(`Decision validation failed with ${result.errors.length} error(s).`)
    process.exit(1)
  }
  console.log("Decision validation passed.")
}
