import { describe, expect, test } from "bun:test"
import path from "path"

async function extractWebSlashCommands(): Promise<Set<string>> {
  const slugs = new Set<string>()

  const files = [
    path.join(import.meta.dir, "../../../app/src/pages/session.tsx"),
    path.join(import.meta.dir, "../../../app/src/pages/layout.tsx"),
    path.join(import.meta.dir, "../../../app/src/components/session/commands.tsx"),
  ]

  for (const filepath of files) {
    const file = Bun.file(filepath)
    const content = await file.text()

    const regex = /slash:\s*"([^"]+)"/g
    let match
    while ((match = regex.exec(content)) !== null) {
      if (match[1]) slugs.add(match[1])
    }
  }

  return slugs
}

describe("web slash commands", () => {
  test("exposes the expected core slash commands in the web UI", async () => {
    const web = await extractWebSlashCommands()

    expect(web.size).toBeGreaterThan(0)

    const expected = ["new", "session", "model", "terminal", "theme", "help"]

    for (const slug of expected) {
      expect(web.has(slug)).toBe(true)
    }
  })
})
