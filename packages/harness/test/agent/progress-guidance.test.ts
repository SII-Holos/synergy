import { expect, test } from "bun:test"
import { buildGeneralPrompt } from "../../src/agent/prompt/general/builder"
import { buildCodingPrompt } from "../../src/agent/prompt/coding/builder"
import { buildLightweightPrompt } from "../../src/agent/prompt/lightweight/builder"
import { withPreambleSection } from "../../src/agent/prompt/preamble"

test("primary prompts provide one shared, task-oriented progress policy", () => {
  for (const built of [buildGeneralPrompt(), buildCodingPrompt(), buildLightweightPrompt()]) {
    const prompt = withPreambleSection(built)
    const section = prompt.match(/(?:^|\n)#+ Progress Updates\n([\s\S]*?)(?=\n#|$)/)?.[1]
    expect(section).toBeDefined()
    expect(section).toContain("new information changes the user's expectations or requires their attention")
    expect(section).toContain("change of approach")
    expect(section).toContain("Judge novelty against what you have already told the user")
    expect(section).toContain("rewording the same issue is not an update")
    expect(section).toContain("Do not narrate routine tool calls or steps")
    expect(section).toContain("Wait for results before conclusions")
    expect(section).toContain(
      "For substantial work, briefly state your initial direction and share meaningful progress",
    )
    expect(section).toContain("Between updates, continue with tools")
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
    expect(prompt).toContain("Judge novelty against what you have already told the user")
    expect(prompt).toContain("rewording the same issue is not an update")
    expect(withPreambleSection(prompt)).toBe(prompt)
    expect(prompt.match(/#+ Progress Updates/g)).toHaveLength(1)
    if (base) expect(prompt).toContain(base)
  }
})
