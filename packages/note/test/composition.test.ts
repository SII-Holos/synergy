import { expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SessionNoteAccess } from "../src/session-contract"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { NoteStore } from "../src"
import { registerNote } from "../src/register"
import { NoteRoute } from "../src/routes/note"
import { NoteListTool } from "../src/tools/note-list"
import { NoteSearchTool } from "../src/tools/note-search"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"

const context: Tool.Context = {
  sessionID: "ses_note_composition",
  messageID: "msg_note_composition",
  agent: "synergy",
  abort: new AbortController().signal,
  metadata() {},
  async ask() {
    throw new Error("Unexpected approval")
  },
}

test("standalone Note registration connects routes, search tools, and blueprint recovery", async () => {
  registerNote()
  registerNote()
  expect(ToolRegistry.toolProviderIDs().filter((id) => id === "note")).toHaveLength(1)
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const scopeID = ScopeContext.current.scope.id
      const created = await NoteRoute.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Research protocol", kind: "blueprint", tags: ["research"] }),
      })
      expect(created.status).toBe(200)
      const note = (await created.json()) as { id: string }
      expect((await NoteRoute.request(`/${note.id}`)).status).toBe(200)
      expect((await NoteRoute.request("/all")).status).toBe(200)
      expect((await NoteRoute.request("/meta")).status).toBe(200)
      expect((await NoteRoute.request("/")).status).toBe(200)
      expect((await NoteRoute.request(`/export/${note.id}`)).status).toBe(200)
      const list = await NoteListTool.init()
      const listed = await list.execute(
        { scope: "current", kind: "blueprint", archived: "active", offset: 0, limit: 20 },
        context,
      )
      expect(listed.output).toContain("Research protocol")
      const search = await NoteSearchTool.init()
      const searched = await search.execute(
        { pattern: "Research", scope: "current", kind: "blueprint", archived: "active", tags: ["research"] },
        context,
      )
      expect(searched.output).toContain("Research protocol")
      const invalid = await search.execute({ pattern: "[", scope: "current", kind: "all", archived: "active" }, context)
      expect(invalid.output).toContain("Invalid regex")
      expect(await SessionNoteAccess.getBlueprintNote(scopeID, note.id)).toEqual({
        noteID: note.id,
        activeLoopID: undefined,
      })
      expect(await SessionNoteAccess.listBlueprintNotes(scopeID)).toHaveLength(1)
      await SessionNoteAccess.setBlueprintActiveLoop(scopeID, note.id, "loop_research")
      expect((await NoteStore.get(scopeID, note.id)).blueprint?.activeLoopID).toBe("loop_research")
      expect((await NoteRoute.request(`/${note.id}`, { method: "DELETE" })).status).toBe(409)
      await SessionNoteAccess.setBlueprintActiveLoop(scopeID, note.id, null)
      await NoteStore.update(scopeID, note.id, { archived: true })
      expect((await NoteRoute.request(`/${note.id}`, { method: "DELETE" })).status).toBe(200)
      expect(await SessionNoteAccess.getBlueprintNote(scopeID, note.id)).toBeUndefined()
    },
  })
})
