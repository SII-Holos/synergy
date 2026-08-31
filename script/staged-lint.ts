#!/usr/bin/env bun

/**
 * Staged-file fast lint for pre-commit. Feeds the staged TS/TSX/JSON file list
 * to oxlint with --fix, re-stages fixed files, and never touches unstaged work.
 */

import path from "node:path"
import { $ } from "bun"

const REPO_ROOT = path.resolve(import.meta.dir, "..")

// oxlint lints JS/TS only; passing it JSON/JSONC paths makes it exit 1 with
// "No files found to lint", so JSON files are intentionally excluded.
const LINTABLE = /\.(ts|tsx|js|jsx|mjs|cjs)$/

async function stagedFiles(cwd: string): Promise<string[]> {
  const result = await $`git diff --cached --name-only --diff-filter=ACMR`.cwd(cwd).quiet()
  return result
    .text()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => LINTABLE.test(line) && !line.includes("node_modules"))
}

export async function runStagedLint(options: { root?: string; cwd?: string } = {}): Promise<{
  files: string[]
  exitCode: number
}> {
  const root = options.root ?? REPO_ROOT
  const cwd = options.cwd ?? root
  const files = await stagedFiles(cwd)
  if (files.length === 0) return { files, exitCode: 0 }

  const output = await $`bunx oxlint -c oxlintrc.json --fix --quiet ${files}`.cwd(root).nothrow()
  if (output.exitCode !== 0) {
    // A staging set consisting solely of oxlint-ignored paths (e.g. the
    // generated SDK tree) makes oxlint exit 1 with "No files found to
    // lint"; that is not a lint failure.
    if (/No files found to lint/.test(output.stderr.toString() + output.stdout.toString())) {
      return { files, exitCode: 0 }
    }
    return { files, exitCode: output.exitCode }
  }

  const restage = await $`git add -- ${files}`.cwd(root).nothrow().quiet()
  if (restage.exitCode !== 0) {
    console.error(`staged-lint: failed to re-stage fixed files (exit ${restage.exitCode})`)
    return { files, exitCode: restage.exitCode }
  }
  return { files, exitCode: 0 }
}

if (import.meta.main) {
  const result = await runStagedLint()
  if (result.files.length === 0) {
    console.log("No staged lintable files.")
    process.exit(0)
  }
  if (result.exitCode !== 0) {
    console.error(`staged-lint: oxlint failed on ${result.files.length} staged file(s) (exit ${result.exitCode})`)
    process.exit(result.exitCode)
  }
  console.log(`staged-lint: ${result.files.length} staged file(s) linted.`)
}
