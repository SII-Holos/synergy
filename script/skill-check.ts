#!/usr/bin/env bun

import { readdir, stat } from "node:fs/promises"
import path from "node:path"

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g

type Frontmatter = {
  name: string
  description: string
}

export async function validateSkillRoot(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  if (entries.length === 0) return [`${root}: no Skill directories found`]

  const errors = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((entry) => validateSkillDirectory(path.join(root, entry.name))),
  )
  return errors.flat()
}

async function validateSkillDirectory(skillDir: string): Promise<string[]> {
  const errors: string[] = []
  const directoryName = path.basename(skillDir)
  const skillFile = path.join(skillDir, "SKILL.md")
  const source = await Bun.file(skillFile)
    .text()
    .catch(() => "")
  if (!source) return [`${relative(skillFile)}: missing or empty SKILL.md`]

  const frontmatter = parseFrontmatter(source, skillFile, errors)
  if (!frontmatter) return errors

  if (frontmatter.name !== directoryName) {
    errors.push(`${relative(skillFile)}: name '${frontmatter.name}' must match directory '${directoryName}'`)
  }
  if (!SKILL_NAME.test(frontmatter.name) || frontmatter.name.length > 64) {
    errors.push(`${relative(skillFile)}: name must be lowercase hyphen-case and at most 64 characters`)
  }
  if (frontmatter.description.length < 40) {
    errors.push(`${relative(skillFile)}: description must explain both behavior and when to use the Skill`)
  }
  if (/\bTODO\b|\[TODO/i.test(source)) {
    errors.push(`${relative(skillFile)}: unresolved TODO placeholder`)
  }

  await validateLinks(source, skillFile, errors)
  await validateOpenAIYaml(skillDir, frontmatter.name, errors)
  return errors
}

function parseFrontmatter(source: string, skillFile: string, errors: string[]): Frontmatter | undefined {
  const match = source.match(FRONTMATTER)
  if (!match) {
    errors.push(`${relative(skillFile)}: missing YAML frontmatter`)
    return
  }

  const values = new Map<string, string>()
  for (const line of match[1].split("\n")) {
    if (!line.trim()) continue
    const field = line.match(/^([a-z_]+):\s*(.+)$/)
    if (!field) {
      errors.push(`${relative(skillFile)}: unsupported frontmatter line '${line}'`)
      continue
    }
    values.set(field[1], parseScalar(field[2], skillFile, errors))
  }

  const unexpected = [...values.keys()].filter((key) => key !== "name" && key !== "description")
  if (unexpected.length > 0) {
    errors.push(`${relative(skillFile)}: unsupported frontmatter fields: ${unexpected.join(", ")}`)
  }
  const name = values.get("name")?.trim()
  const description = values.get("description")?.trim()
  if (!name) errors.push(`${relative(skillFile)}: missing name`)
  if (!description) errors.push(`${relative(skillFile)}: missing description`)
  if (!name || !description) return
  return { name, description }
}

function parseScalar(raw: string, file: string, errors: string[]): string {
  if (!raw.startsWith('"')) return raw.trim()
  try {
    const value = JSON.parse(raw)
    if (typeof value === "string") return value
  } catch {}
  errors.push(`${relative(file)}: invalid quoted YAML scalar '${raw}'`)
  return ""
}

async function validateLinks(source: string, skillFile: string, errors: string[]) {
  for (const match of source.matchAll(MARKDOWN_LINK)) {
    let target = match[1].trim()
    if (!target || target.startsWith("#") || /^[a-z]+:/i.test(target)) continue
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1)
    target = target.split("#", 1)[0].split("?", 1)[0]
    const resolved = path.resolve(path.dirname(skillFile), decodeURIComponent(target))
    const exists = await stat(resolved)
      .then(() => true)
      .catch(() => false)
    if (!exists) errors.push(`${relative(skillFile)}: broken relative link '${match[1]}'`)
  }
}

async function validateOpenAIYaml(skillDir: string, skillName: string, errors: string[]) {
  const file = path.join(skillDir, "agents", "openai.yaml")
  const source = await Bun.file(file)
    .text()
    .catch(() => "")
  if (!source) return
  if (!source.startsWith("interface:\n")) {
    errors.push(`${relative(file)}: expected an interface mapping`)
    return
  }

  const values = new Map<string, string>()
  for (const line of source.split("\n").slice(1)) {
    if (!line.trim()) continue
    const field = line.match(/^  ([a-z_]+):\s*("(?:[^"\\]|\\.)*")$/)
    if (!field) {
      errors.push(`${relative(file)}: interface values must be quoted strings ('${line}')`)
      continue
    }
    values.set(field[1], parseScalar(field[2], file, errors))
  }

  for (const key of ["display_name", "short_description", "default_prompt"]) {
    if (!values.get(key)) errors.push(`${relative(file)}: missing interface.${key}`)
  }
  const short = values.get("short_description") ?? ""
  if (short && (short.length < 25 || short.length > 64)) {
    errors.push(`${relative(file)}: short_description must be 25-64 characters`)
  }
  const prompt = values.get("default_prompt") ?? ""
  if (prompt && !prompt.includes(`$${skillName}`)) {
    errors.push(`${relative(file)}: default_prompt must mention $${skillName}`)
  }
}

function relative(file: string) {
  return path.relative(process.cwd(), file) || "."
}

if (import.meta.main) {
  const root = path.resolve(process.argv[2] ?? ".synergy/skill")
  const errors = await validateSkillRoot(root)
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`)
    console.error(`Skill validation failed with ${errors.length} error(s).`)
    process.exit(1)
  }
  const count = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length
  console.log(`Validated ${count} repository Skills.`)
}
