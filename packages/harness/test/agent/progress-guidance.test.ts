import { expect, test } from "bun:test"
import { buildSynergyPrompt } from "../../src/agent/prompt/synergy/builder"
import { buildSynergyMaxPrompt } from "../../src/agent/prompt/synergy-max/builder"
import { buildSynergyFlashPrompt } from "../../src/agent/prompt/synergy-flash/builder"
import { withPreambleSection } from "../../src/agent/prompt/preamble"

test("primary prompts provide one shared, task-oriented progress policy", () => {
  for (const built of [buildSynergyPrompt([]), buildSynergyMaxPrompt([]), buildSynergyFlashPrompt()]) {
    const prompt = withPreambleSection(built)
    const section = prompt.match(/(?:^|\n)#+ Progress Updates\n([\s\S]*?)(?=\n#|$)/)?.[1]
    expect(section).toBeDefined()
    expect(section).toContain("important finding")
    expect(section).toContain("change of approach")
    expect(section).toContain("Do not narrate each tool call")
    expect(section).toContain("result before stating a conclusion")
    expect(section).toContain("Prefer continuing with tools")
    expect(section).not.toContain("begin with one short sentence")
    expect(section).not.toContain("about a minute")
    expect(prompt.match(/#+ Progress Updates/g)).toHaveLength(1)
    expect(prompt).not.toContain("{PROGRESS_UPDATES}")
    expect(prompt.includes("## Preamble Messages")).toBe(false)
    expect(prompt.includes("Tool calls are already visible")).toBe(false)
  }
})

test("custom and empty prompts receive the shared progress policy exactly once", () => {
  for (const base of [undefined, "You inspect local projects."]) {
    const prompt = withPreambleSection(base)
    expect(prompt).toContain("Do not narrate each tool call")
    expect(prompt).toContain("A routine result or another model reply alone does not need an update")
    expect(withPreambleSection(prompt)).toBe(prompt)
    expect(prompt.match(/#+ Progress Updates/g)).toHaveLength(1)
    if (base) expect(prompt).toContain(base)
  }
})
