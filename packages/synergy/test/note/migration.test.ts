import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Scope } from "../../src/scope"
import { Identifier } from "../../src/id/id"
import { NoteDocument, NoteMarkdown } from "../../src/note"
import { migrations } from "../../src/note/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"

describe("note migrations", () => {
  test("adds unique blockId attrs to legacy editable blocks without changing rendered text", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const noteID = Identifier.ascending("note")
    const now = Date.now()
    const content = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Migration target" }] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Nested item" }] }] },
          ],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "A1" }] }] },
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "B1" }] }] },
              ],
            },
          ],
        },
        { type: "mermaid", attrs: { content: "graph TD; A-->B;" } },
        { type: "video", attrs: { src: "https://example.com/video.mp4" } },
      ],
    }
    const beforeMarkdown = NoteMarkdown.toMarkdown(content)

    await Storage.write(StoragePath.note(scopeID, noteID), {
      id: noteID,
      title: "Legacy blocks",
      content,
      kind: "note",
      pinned: false,
      global: false,
      tags: [],
      version: 1,
      time: { created: now, updated: now },
    })
    await Storage.write(StoragePath.note(scopeID, "_index"), { stale: true })

    const migration = migrations.find((entry) => entry.id === "20260626-note-add-block-ids")
    expect(migration).toBeDefined()
    await migration!.up(() => {})

    const migrated = await Storage.read<{ content: unknown }>(StoragePath.note(scopeID, noteID))
    const blocks = NoteDocument.listBlocks(migrated.content)
    const ids = blocks.map((block) => block.id)

    expect(blocks.some((block) => block.type === "tableCell" && block.text.includes("A1"))).toBe(true)
    expect(blocks.some((block) => block.type === "listItem" && block.text.includes("Nested item"))).toBe(true)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith("blk_"))).toBe(true)
    expect(JSON.stringify(migrated.content)).toContain('"blockId"')
    expect(JSON.stringify(migrated.content)).not.toContain('"synergyId"')
    expect(NoteMarkdown.toMarkdown(migrated.content)).toBe(beforeMarkdown)
    await expect(Storage.read(StoragePath.note(scopeID, "_index"))).rejects.toBeInstanceOf(Storage.NotFoundError)
  })
})
