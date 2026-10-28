import { expect, test } from "bun:test"
import path from "node:path"
import { buildGeneralPrompt } from "../../src/agent/prompt/general/builder"
import { buildCodingPrompt } from "../../src/agent/prompt/coding/builder"
import { buildLightweightPrompt } from "../../src/agent/prompt/lightweight/builder"
import { PROGRESS_UPDATES, withProgressUpdates } from "../../src/agent/prompt/progress"

const model = { id: "gpt-5", api: { id: "gpt-5" } }

test("primary prompts provide one shared, task-oriented progress policy", () => {
  for (const built of [buildGeneralPrompt(), buildCodingPrompt(), buildLightweightPrompt()]) {
    expect(built).not.toContain(PROGRESS_UPDATES)
    const prompt = withProgressUpdates(built, model)
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
    const prompt = withProgressUpdates(base, model)
    expect(prompt).toContain("Judge novelty against what you have already told the user")
    expect(prompt).toContain("rewording the same issue is not an update")
    expect(withProgressUpdates(prompt, model)).toBe(prompt)
    expect(prompt.match(/#+ Progress Updates/g)).toHaveLength(1)
    if (base) expect(prompt).toContain(base)
  }
})

test("DeepSeek exclusions follow model identities, including aliases and gateway namespaces", () => {
  for (const excluded of [
    { id: "deepseek-chat", api: { id: "anonymous" } },
    { id: "local-alias", api: { id: "deepseek-reasoner" } },
    { id: "local-alias", api: { id: "deepseek-ai/DeepSeek-V4-Flash" } },
    { id: "local-alias", api: { id: "deepseek.r1-v1:0" } },
    { id: "local-alias", api: { id: "deepseek.v3-v1:0" } },
    { id: "local-alias", api: { id: "us.deepseek.r1-v1:0" } },
    { id: "deepseek/deepseek-r1:free", api: { id: "anonymous" } },
    { id: "local-alias", api: { id: "anonymous" }, family: "deepseek" },
    { id: "local-alias", api: { id: "anonymous" }, family: "deepseek-v3" },
  ]) {
    expect(withProgressUpdates(undefined, excluded)).toBe("")
    expect(withProgressUpdates("  Keep this instruction.  ", excluded)).toBe("Keep this instruction.")
    for (const build of [buildGeneralPrompt, buildCodingPrompt, buildLightweightPrompt]) {
      expect(withProgressUpdates(build(), excluded)).toBe(build().trim())
    }
  }
})

test("unlisted model families keep progress guidance regardless of provider or display names", () => {
  for (const id of ["gpt-5", "claude-sonnet-4-5", "gemini-2.5-pro", "unknown", "notdeepseek", "deepseek/claude"]) {
    const allowed = { id, api: { id }, providerID: "deepseek", name: "DeepSeek connection" }
    expect(withProgressUpdates(undefined, allowed)).toBe(PROGRESS_UPDATES)
  }
})

test("explicit custom communication instructions are preserved without a second shared policy", () => {
  for (const prompt of ["## Progress Updates\n\nAsk before changing scope.", "## Preamble Messages\n\nStay concise."]) {
    expect(withProgressUpdates(prompt, model)).toBe(prompt)
    expect(withProgressUpdates(prompt, { id: "deepseek-chat", api: { id: "deepseek-chat" } })).toBe(prompt)
  }
})

test("no agent prompt carries its own second progress policy", async () => {
  const root = path.join(import.meta.dir, "../../src/agent/prompt")
  const files = [...new Bun.Glob("*/base.txt").scanSync({ cwd: root })]
  expect(files.length).toBeGreaterThan(20)
  for (const file of files) {
    const raw = await Bun.file(path.join(root, file)).text()
    // `withProgressUpdates` appends unless the prompt already carries the shared heading, so a
    // drifted prompt that words its own policy differently receives both at runtime.
    const assembled = withProgressUpdates(raw, model)
    // Only headings that announce a progress-reporting policy count; unrelated content such as
    // "What is currently in progress" is a compaction field, not a second policy.
    expect(assembled.match(/^#+ .*[Pp]rogress [Uu]pdate.*$/gm) ?? [], file).toHaveLength(1)
    expect(assembled, file).not.toContain("about to do")
    expect(assembled, file).not.toContain("large chunks of work")
  }
})
