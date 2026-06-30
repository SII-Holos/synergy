import { describe, expect, test } from "bun:test"

const settingsDir = new URL(".", import.meta.url)

async function readSettingsFile(path: string) {
  return Bun.file(new URL(path, settingsDir)).text()
}

async function readSettingsTsxFiles() {
  const glob = new Bun.Glob("**/*.tsx")
  const files: Array<{ path: string; content: string }> = []

  for await (const path of glob.scan({ cwd: settingsDir.pathname })) {
    files.push({ path, content: await readSettingsFile(path) })
  }

  return files
}

describe("settings typography contract", () => {
  test("settings CSS uses semantic type tokens instead of naked pixel font sizes", async () => {
    const css = await readSettingsFile("settings-panel.css")
    expect(css).not.toMatch(/font-size:\s*\d+(?:\.\d+)?px\b/)
    expect(css).toContain("var(--type-ui-page-title-size)")
    expect(css).toContain("var(--type-ui-body-size)")
  })

  test("settings CSS uses tokenized weights instead of temporary numeric weights", async () => {
    const css = await readSettingsFile("settings-panel.css")
    expect(css).not.toMatch(/font-weight:\s*(?:400|500|550|600|650|700)\b/)
    expect(css).toContain("var(--font-weight-semibold)")
    expect(css).toContain("var(--font-weight-medium)")
  })

  test("settings TSX does not depend on legacy text-size utilities", async () => {
    const files = await readSettingsTsxFiles()
    for (const file of files) {
      expect(file.content, `${file.path} should use settings typography classes`).not.toMatch(
        /\btext-(?:10|11|12|13|14)-(?:regular|medium|semibold|bold|mono)\b/,
      )
    }
  })
})
