#!/usr/bin/env bun

import { $ } from "bun"
import { parseArgs } from "util"
import { currentRepo } from "./shared/current-repo"

export async function getLatestRelease() {
  const env = {
    GH_TOKEN: process.env.SYNERGY_RELEASE_TOKEN || process.env.GITHUB_TOKEN || process.env.RELEASE_TOKEN || "",
  }
  const repo = await currentRepo()
  const result = await $`gh api /repos/${repo}/releases/latest --jq '.tag_name'`.env(env).nothrow().quiet()
  if (result.exitCode !== 0) return null
  const tag = result.text().trim()
  return tag ? tag.replace(/^v/, "") : null
}

type Commit = {
  hash: string
  author: string | null
  message: string
  areas: Set<string>
}

export async function getCommits(from: string, to: string): Promise<Commit[]> {
  const fromRef = from.startsWith("v") ? from : `v${from}`
  const toRef = to === "HEAD" ? to : to.startsWith("v") ? to : `v${to}`

  const repo = await currentRepo()
  const compare =
    await $`gh api "/repos/${repo}/compare/${fromRef}...${toRef}" --jq '.commits[] | {sha: .sha, login: .author.login, message: .commit.message}'`.text()

  const commitData = new Map<string, { login: string | null; message: string }>()
  for (const line of compare.split("\n").filter(Boolean)) {
    const data = JSON.parse(line) as { sha: string; login: string | null; message: string }
    commitData.set(data.sha, { login: data.login, message: data.message.split("\n")[0] ?? "" })
  }

  const log =
    await $`git log ${fromRef}..${toRef} --oneline --format="%H" -- packages/synergy packages/sdk packages/plugin packages/app packages/config-ui`.text()
  const hashes = log.split("\n").filter(Boolean)

  const commits: Commit[] = []
  for (const hash of hashes) {
    const data = commitData.get(hash)
    if (!data) continue

    const message = data.message
    if (message.match(/^(ignore:|test:|chore:|ci:|release:)/i)) continue

    const files = await $`git diff-tree --no-commit-id --name-only -r ${hash}`.text()
    const areas = new Set<string>()

    for (const file of files.split("\n").filter(Boolean)) {
      if (file.startsWith("packages/synergy/")) areas.add("core")
      else if (file.startsWith("packages/app/")) areas.add("app")
      else if (file.startsWith("packages/sdk/")) areas.add("sdk")
      else if (file.startsWith("packages/plugin/")) areas.add("plugin")
      else if (file.startsWith("packages/config-ui/")) areas.add("app")
    }

    if (areas.size === 0) continue

    commits.push({
      hash: hash.slice(0, 7),
      author: data.login,
      message,
      areas,
    })
  }

  return filterRevertedCommits(commits)
}

function filterRevertedCommits(commits: Commit[]): Commit[] {
  const revertPattern = /^Revert "(.+)"$/
  const seen = new Map<string, Commit>()

  for (const commit of commits) {
    const match = commit.message.match(revertPattern)
    if (match) {
      const original = match[1]!
      if (seen.has(original)) seen.delete(original)
      else seen.set(commit.message, commit)
    } else {
      const revertMsg = `Revert "${commit.message}"`
      if (seen.has(revertMsg)) seen.delete(revertMsg)
      else seen.set(commit.message, commit)
    }
  }

  return [...seen.values()]
}

const sections = {
  core: "Core",
  app: "App",
  sdk: "SDK",
  plugin: "SDK",
} as const

function getSection(areas: Set<string>): string {
  const priority = ["core", "app", "sdk", "plugin"]
  for (const area of priority) {
    if (areas.has(area)) return sections[area as keyof typeof sections]
  }
  return "Core"
}

export function generateChangelog(commits: Commit[]) {
  const grouped = new Map<string, string[]>()

  for (const commit of commits) {
    const section = getSection(commit.areas)
    const attribution = commit.author ? ` (@${commit.author})` : ""
    const entry = `- ${commit.message}${attribution}`

    if (!grouped.has(section)) grouped.set(section, [])
    grouped.get(section)!.push(entry)
  }

  const sectionOrder = ["Core", "App", "SDK", "Extensions"]
  const lines: string[] = []

  for (const section of sectionOrder) {
    const entries = grouped.get(section)
    if (!entries || entries.length === 0) continue
    lines.push(`## ${section}`)
    lines.push(...entries)
  }

  return lines
}

export async function buildNotes(from: string, to: string) {
  const commits = await getCommits(from, to)

  if (commits.length === 0) {
    return []
  }

  console.log("generating changelog since " + from)
  return generateChangelog(commits)
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      from: { type: "string", short: "f" },
      to: { type: "string", short: "t", default: "HEAD" },
      help: { type: "boolean", short: "h", default: false },
    },
  })

  if (values.help) {
    console.log(`
Usage: bun script/changelog.ts [options]

Options:
  -f, --from <version>   Starting version (default: latest GitHub release)
  -t, --to <ref>         Ending ref (default: HEAD)
  -h, --help             Show this help message

Examples:
  bun script/changelog.ts                     # Latest release to HEAD
  bun script/changelog.ts --from 1.0.200      # v1.0.200 to HEAD
  bun script/changelog.ts -f 1.0.200 -t 1.0.205
`)
    process.exit(0)
  }

  const to = values.to!
  const from = values.from ?? (await getLatestRelease())

  if (!from) {
    console.log("No previous release found")
    process.exit(0)
  }

  console.log(`Generating changelog: v${from} -> ${to}\n`)

  const notes = await buildNotes(from, to)
  console.log("\n=== Changelog ===")
  console.log(notes.join("\n"))
}
