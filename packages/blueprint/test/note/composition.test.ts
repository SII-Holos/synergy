import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SessionNoteAccess } from "../../src/session-contract"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { registerNote } from "@ericsanchezok/synergy-note/register"
import { NoteRoute } from "@ericsanchezok/synergy-note/routes/note"
import { NoteListTool } from "@ericsanchezok/synergy-note/tools/note-list"
import { NoteSearchTool } from "@ericsanchezok/synergy-note/tools/note-search"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "./runtime"
const runtime = await testRuntime()

const context: Tool.Context = {
  sessionID: "ses_note_composition",
  messageID: "msg_note_composition",
  agent: PrimaryAgentIdentity.names.general,
  abort: new AbortController().signal,
  metadata() {},
  async ask() {
    throw new Error("Unexpected approval")
  },
}

test("Blueprint registration connects Note routes, search tools, and recovery", () =>
  runtime.run(async () => {
    registerNote()
    registerNote()
    expect(ToolRegistry.toolProviderIDs().filter((id) => id === "note")).toHaveLength(1)
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const write = await ToolRegistry.find("note_write")
        expect(write?.description).toContain("Blueprint")
        expect(write?.description).toContain("Plan")
        expect(write?.description).not.toContain("Lattice")
        const scopeID = ScopeContext.current.scope.id
        const created = await NoteRoute().request("/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Research protocol", kind: "blueprint", tags: ["research"] }),
        })
        expect(created.status).toBe(200)
        const note = (await created.json()) as { id: string }
        expect((await NoteRoute().request(`/${note.id}`)).status).toBe(200)
        expect((await NoteRoute().request("/all")).status).toBe(200)
        expect((await NoteRoute().request("/meta")).status).toBe(200)
        expect((await NoteRoute().request("/")).status).toBe(200)
        expect((await NoteRoute().request(`/export/${note.id}`)).status).toBe(200)
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
        expect(searched.output).toContain("[blueprint]")
        const invalid = await search.execute(
          { pattern: "[", scope: "current", kind: "all", archived: "active" },
          context,
        )
        expect(invalid.output).toContain("Invalid regex")
        expect(await SessionNoteAccess.getBlueprintNote(scopeID, note.id)).toEqual({
          noteID: note.id,
          activeLoopID: undefined,
        })
        expect(await SessionNoteAccess.listBlueprintNotes(scopeID)).toHaveLength(1)
        const loop = { id: "loop_research", noteID: note.id, scopeID, sessionID: context.sessionID, source: "user" }
        await Storage.write(["blueprint_loops", scopeID, loop.id], loop)
        await SessionNoteAccess.setBlueprintActiveLoop(scopeID, note.id, loop.id, loop.source)
        expect((await NoteStore.get(scopeID, note.id)).blueprint?.activeLoopID).toBe("loop_research")
        expect((await NoteRoute().request(`/${note.id}`, { method: "DELETE" })).status).toBe(409)
        await SessionNoteAccess.setBlueprintActiveLoop(scopeID, note.id, null)
        await NoteStore.update(scopeID, note.id, { archived: true })
        expect((await NoteRoute().request(`/${note.id}`, { method: "DELETE" })).status).toBe(200)
        expect(await SessionNoteAccess.getBlueprintNote(scopeID, note.id)).toBeUndefined()
      },
    })
  }))

afterRuntimeTests(() => runtime.close())
