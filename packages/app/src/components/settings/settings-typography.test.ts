import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const settingsDir = new URL(".", import.meta.url)
const settingsPath = fileURLToPath(settingsDir)

async function readSettingsFile(path: string) {
  return Bun.file(new URL(path, settingsDir)).text()
}

async function readSettingsTsxFiles(directory = settingsPath): Promise<Array<{ path: string; content: string }>> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: Array<{ path: string; content: string }> = []

  for (const entry of entries) {
    const filepath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await readSettingsTsxFiles(filepath)))
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".tsx")) continue
    const path = relative(settingsPath, filepath).replaceAll("\\", "/")
    files.push({ path, content: await Bun.file(filepath).text() })
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
