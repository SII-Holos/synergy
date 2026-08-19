#!/usr/bin/env bun

/**
 * Document gate: dead links, one-physical-line paragraphs, and word budgets.
 * Also re-checks generated reference catalogs when their generators exist.
 *
 * Modes:
 *   bun script/doc-check.ts            check everything in scope
 *   bun script/doc-check.ts --staged   check only git-staged markdown files
 *   bun script/doc-check.ts --fix      repair paragraph wrapping where safe
 */

import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"

const REPO_ROOT = path.resolve(import.meta.dir, "..")

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g
const FENCE = /^\s*(```|~~~)/
const HTML_COMMENT_START = /^\s*<!--/
const HTML_COMMENT_END = /-->\s*$/
const HEADING = /^\s*#{1,6}\s/
const LIST_MARK = /^\s*([-*+]|\d+[.)])\s+/
const TABLE_ROW = /^\s*\|/
const BLOCKQUOTE = /^\s*>/
const RAW_HTML_TAG = /^\s*<\/?[a-zA-Z][^>]*>\s*$/

interface BudgetsFile {
  defaults: Record<string, number>
  files: Record<string, number>
}

export interface DocCheckOptions {
  staged?: boolean
  fix?: boolean
  root?: string
  cwd?: string
}

export interface DocCheckResult {
  errors: string[]
  fixed: number
}

function relative(file: string, cwd: string) {
  return path.relative(cwd, file) || "."
}

async function stagedFiles(cwd: string): Promise<string[]> {
  const result = await $`git diff --cached --name-only --diff-filter=ACMR`.cwd(cwd).quiet()
  return result
    .text()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".md"))
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const candidates: string[] = ["README.md", "CONTRIBUTING.md", "AGENTS.md", "docs", ".synergy/skill"]
  const packages = path.join(root, "packages")
  const packageAgents: string[] = []
  for (const entry of await readdir(packages, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) packageAgents.push(path.join("packages", entry.name, "AGENTS.md"))
  }
  for (const relativePath of [...candidates, ...packageAgents]) {
    const full = path.join(root, relativePath)
    const info = await stat(full).catch(() => null)
    if (!info) continue
    if (info.isFile() && full.endsWith(".md")) files.push(full)
    else if (info.isDirectory()) await walk(full, files)
  }
  return files.sort()
}

async function walk(dir: string, out: string[]) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, out)
    else if (entry.name.endsWith(".md")) out.push(full)
  }
}

export function slugifyAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
}

function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>()
  for (const line of markdown.split("\n")) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)
    if (match) anchors.add(slugifyAnchor(match[1]!))
  }
  return anchors
}

interface Link {
  raw: string
  target: string
  fragment: string
  line: number
}

export function extractLinks(markdown: string): Link[] {
  const links: Link[] = []
  const lines = markdown.split("\n")
  let inFence = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (RAW_HTML_TAG.test(line) && !HTML_COMMENT_START.test(line)) continue
    for (const match of line.matchAll(MARKDOWN_LINK)) {
      if (insideCodeSpan(line, match.index)) continue
      const raw = match[1]!.trim()
      if (!raw || raw.startsWith("#")) continue
      const stripped = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw
      if (/^[a-z][a-z0-9+.-]*:/i.test(stripped)) continue
      const [targetPart, ...rest] = stripped.split("#")
      if (rest.length > 1 || !targetPart || /[\s]/.test(targetPart)) continue
      links.push({ raw, target: targetPart, fragment: rest.length === 1 ? rest[0]! : "", line: index + 1 })
    }
  }
  return links
}

function insideCodeSpan(line: string, position: number): boolean {
  let inSpan = false
  for (let index = 0; index < line.length; index++) {
    if (line[index] === "`") {
      inSpan = !inSpan
    } else if (index === position && inSpan) {
      return true
    }
  }
  return false
}

async function checkLinks(files: string[], cwd: string, errors: string[]): Promise<void> {
  for (const file of files) {
    const markdown = await readFile(file, "utf8")
    for (const link of extractLinks(markdown)) {
      let targetPath: string
      try {
        targetPath = path.resolve(path.dirname(file), decodeURIComponent(link.target))
      } catch {
        errors.push(`${relative(file, cwd)}:${link.line}: unparseable link target '${link.raw}'`)
        continue
      }
      const targetInfo = await stat(targetPath).catch(() => null)
      if (!targetInfo) {
        errors.push(`${relative(file, cwd)}:${link.line}: broken link '${link.raw}'`)
        continue
      }
      if (link.fragment && targetInfo.isFile() && targetPath.endsWith(".md")) {
        const anchors = anchorsOf(await readFile(targetPath, "utf8"))
        if (!anchors.has(slugifyAnchor(link.fragment))) {
          errors.push(`${relative(file, cwd)}:${link.line}: missing anchor '#${link.fragment}' in '${link.target}'`)
        }
      }
    }
  }
}

function isSpecialLine(line: string): boolean {
  return (
    line.trim() === "" ||
    HEADING.test(line) ||
    LIST_MARK.test(line) ||
    TABLE_ROW.test(line) ||
    BLOCKQUOTE.test(line) ||
    RAW_HTML_TAG.test(line)
  )
}

/**
 * Rewraps plain prose so every paragraph is one physical line. Special
 * constructs (headings, lists, tables, blockquotes, fenced blocks, HTML) are
 * never merged; only consecutive plain-text lines are joined.
 */
export function reflowMarkdown(markdown: string): { text: string; joined: number } {
  const lines = markdown.split("\n")
  const output: string[] = []
  let inFence = false
  let inHtmlComment = false
  let inFrontmatter = false
  let frontmatterOpen = false
  let joined = 0
  let index = 0

  if (lines[0] === "---") {
    inFrontmatter = true
    frontmatterOpen = true
  }

  while (index < lines.length) {
    const line = lines[index]!
    if (inFrontmatter) {
      output.push(line)
      if (index > 0 && line === "---" && frontmatterOpen) inFrontmatter = false
      index++
      continue
    }
    if (FENCE.test(line)) {
      inFence = !inFence
      output.push(line)
      index++
      continue
    }
    if (inFence) {
      output.push(line)
      index++
      continue
    }
    if (!inHtmlComment && HTML_COMMENT_START.test(line) && !HTML_COMMENT_END.test(line)) {
      inHtmlComment = true
      output.push(line)
      index++
      continue
    }
    if (inHtmlComment) {
      output.push(line)
      if (HTML_COMMENT_END.test(line)) inHtmlComment = false
      index++
      continue
    }
    if (isSpecialLine(line)) {
      output.push(line)
      index++
      continue
    }
    let merged = line
    let cursor = index + 1
    while (cursor < lines.length && !isSpecialLine(lines[cursor]!) && !FENCE.test(lines[cursor]!)) {
      const candidate = lines[cursor]!
      if (!inHtmlComment && HTML_COMMENT_START.test(candidate)) break
      merged += ` ${candidate.trim()}`
      cursor++
    }
    if (cursor > index + 1) joined++
    output.push(merged)
    index = cursor
  }
  return { text: output.join("\n"), joined }
}

export function findWrapViolations(markdown: string): number[] {
  const violations: number[] = []
  const lines = markdown.split("\n")
  let inFence = false
  let inHtmlComment = false
  let inFrontmatter = false
  let frontmatterOpen = false
  if (lines[0] === "---") {
    inFrontmatter = true
    frontmatterOpen = true
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (inFrontmatter) {
      if (index > 0 && line === "---" && frontmatterOpen) inFrontmatter = false
      continue
    }
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (!inHtmlComment && HTML_COMMENT_START.test(line) && !HTML_COMMENT_END.test(line)) {
      inHtmlComment = true
      continue
    }
    if (inHtmlComment) {
      if (HTML_COMMENT_END.test(line)) inHtmlComment = false
      continue
    }
    if (isSpecialLine(line)) continue
    const next = lines[index + 1] ?? ""
    if (next.trim() !== "" && !isSpecialLine(next) && !FENCE.test(next)) {
      violations.push(index + 1)
    }
  }
  return violations
}

async function checkWrap(files: string[], cwd: string, errors: string[], fix: boolean): Promise<number> {
  let fixed = 0
  for (const file of files) {
    const markdown = await readFile(file, "utf8")
    if (fix) {
      const { text, joined } = reflowMarkdown(markdown)
      fixed += joined
      const normalized = text.endsWith("\n") ? text : `${text}\n`
      if (normalized !== markdown) await Bun.write(file, normalized)
    } else {
      for (const line of findWrapViolations(markdown)) {
        errors.push(
          `${relative(file, cwd)}:${line}: paragraph continues on the next line (one physical line per paragraph)`,
        )
      }
    }
  }
  return fixed
}

async function loadBudgets(root: string): Promise<BudgetsFile> {
  const raw = await readFile(path.join(root, "script", "doc-budgets.json"), "utf8")
  return JSON.parse(raw) as BudgetsFile
}

async function budgetTargets(root: string, budgets: BudgetsFile): Promise<Array<[string, number]>> {
  const targets: Array<[string, number]> = []
  for (const [file, limit] of Object.entries(budgets.files)) {
    targets.push([path.join(root, file), limit])
  }
  const packages = path.join(root, "packages")
  for (const entry of await readdir(packages, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const full = path.join(packages, entry.name, "AGENTS.md")
    if (!budgets.files[path.relative(root, full)] && budgets.defaults["AGENTS.md"]) {
      targets.push([full, budgets.defaults["AGENTS.md"]])
    }
  }
  return targets
}

async function checkBudgets(root: string, cwd: string, errors: string[]): Promise<void> {
  const budgets = await loadBudgets(root)
  for (const [file, limit] of await budgetTargets(root, budgets)) {
    const markdown = await readFile(file, "utf8").catch(() => null)
    if (markdown === null) continue
    const words = markdown.trim().split(/\s+/).filter(Boolean).length
    if (words > limit) {
      errors.push(`${relative(file, cwd)}: ${words} words exceeds budget of ${limit}`)
    }
  }
}

const GENERATORS = ["gen-cli-reference.ts", "gen-config-reference.ts", "gen-tool-catalog.ts"]

async function checkGeneratedFreshness(root: string, errors: string[]): Promise<void> {
  for (const generator of GENERATORS) {
    const script = path.join(root, "script", "gen", generator)
    const exists = await stat(script)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue
    const result = await $`bun ${script} --check`.cwd(root).nothrow().quiet()
    if (result.exitCode !== 0) {
      const output = result.stdout.toString().trim()
      errors.push(
        `generated catalog is stale (${generator}): ${output || `exit ${result.exitCode}`} — run bun ${path.join("script", "gen", generator)}`,
      )
    }
  }
}

/**
 * Restrict staged markdown files to the same document scope the full check
 * covers, so pre-commit and `doc:check` agree on which files must satisfy the
 * paragraph-wrap contract. Files outside that scope (e.g. PRODUCT.md) keep
 * their own formatting conventions.
 */
export function filterStagedFiles(staged: string[], scope: string[], cwd: string): string[] {
  return staged.filter((file) => scope.includes(path.resolve(cwd, file)))
}

export async function runDocCheck(options: DocCheckOptions = {}): Promise<DocCheckResult> {
  const root = options.root ?? REPO_ROOT
  const cwd = options.cwd ?? root
  const errors: string[] = []
  let fixed = 0
  const scope = await collectMarkdownFiles(root)
  const files = options.staged ? filterStagedFiles(await stagedFiles(cwd), scope, cwd) : scope
  await checkLinks(files, cwd, errors)
  fixed += await checkWrap(files, cwd, errors, options.fix ?? false)
  if (!options.staged) {
    await checkBudgets(root, cwd, errors)
    await checkGeneratedFreshness(root, errors)
  }
  return { errors, fixed }
}

if (import.meta.main) {
  const staged = process.argv.includes("--staged")
  const fix = process.argv.includes("--fix")
  const result = await runDocCheck({ staged, fix })
  if (result.fixed > 0) console.log(`Rewrapped ${result.fixed} paragraph block(s).`)
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`- ${error}`)
    console.error(`Document validation failed with ${result.errors.length} error(s).`)
    process.exit(1)
  }
  console.log("Document validation passed.")
}
