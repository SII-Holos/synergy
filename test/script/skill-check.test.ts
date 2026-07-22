import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { validateSkillRoot } from "../../script/skill-check"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-skill-check-"))
  roots.push(root)
  const skill = path.join(root, "example-skill")
  await mkdir(path.join(skill, "agents"), { recursive: true })
  await writeFile(path.join(skill, "reference.md"), "# Reference\n")
  await writeFile(
    path.join(skill, "SKILL.md"),
    `---
name: example-skill
description: Apply a focused example workflow. Use when validating repository Skill structure and links.
---

# Example Skill

Read [the reference](reference.md), then perform the task.
`,
  )
  await writeFile(
    path.join(skill, "agents", "openai.yaml"),
    `interface:
  display_name: "Example Skill"
  short_description: "Validate an example repository Skill"
  default_prompt: "Use $example-skill to validate this example workflow."
`,
  )
  return { root, skill }
}

describe("repository Skill validation", () => {
  test("accepts a complete Skill with valid metadata, UI metadata, and links", async () => {
    const { root } = await fixture()
    expect(await validateSkillRoot(root)).toEqual([])
  })

  test("reports name, link, and default-prompt violations together", async () => {
    const { root, skill } = await fixture()
    await writeFile(
      path.join(skill, "SKILL.md"),
      `---
name: wrong-name
description: Apply a focused example workflow. Use when validating repository Skill structure and links.
---

# Example Skill

Read [the missing reference](missing.md).
`,
    )
    await writeFile(
      path.join(skill, "agents", "openai.yaml"),
      `interface:
  display_name: "Example Skill"
  short_description: "Validate an example repository Skill"
  default_prompt: "Validate this example workflow."
`,
    )

    const errors = await validateSkillRoot(root)
    expect(errors.some((error) => error.includes("must match directory"))).toBe(true)
    expect(errors.some((error) => error.includes("missing.md"))).toBe(true)
    expect(errors.some((error) => error.includes("$wrong-name"))).toBe(true)
  })
})
