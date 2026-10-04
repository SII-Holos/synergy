import { expect, test } from "bun:test"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { noteTools, registerNoteToolInputHistory } from "../src/tools"

const toolkit = noteTools()

test("selective Note hosts retain owned history without registering product groups", async () => {
  await using runtime = await testRuntime({
    register() {
      registerNoteToolInputHistory()
      registerNoteToolInputHistory()
    },
  })
  await runtime.run(async () => {
    expect(toolkit.map((tool) => tool.id)).toContain("note_write")
    expect(
      Tool.upgradeInput("note_write", { id: "note", title: "Old", noteTitle: "Current", content: "Body" }),
    ).toEqual({
      noteId: "note",
      noteTitle: "Current",
      noteContent: "Body",
    })
    expect(Tool.upgradeInput("note_read", { ids: ["note"] })).toEqual({ noteIds: ["note"] })
    expect(Tool.upgradeInput("note_archive", { ids: ["note"] })).toEqual({ noteIds: ["note"] })
    expect(MigrationRegistry.list().get("tool-input-note")).toHaveLength(1)
  })
  await using independent = await testRuntime()
  await independent.run(async () => {
    expect(Tool.upgradeInput("note_write", { title: "Unregistered" })).toEqual({ title: "Unregistered" })
    expect(MigrationRegistry.list().has("tool-input-note")).toBe(false)
  })
})
