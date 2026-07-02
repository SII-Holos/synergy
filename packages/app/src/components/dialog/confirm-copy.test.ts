import { describe, expect, test } from "bun:test"
import {
  agendaActionConfirm,
  archiveProjectConfirm,
  archiveSessionConfirm,
  deleteLibraryItemsConfirm,
  deleteNoteConfirm,
  deleteSkillConfirm,
  discardSettingsConfirm,
  overwriteImportConfirm,
  uninstallPluginConfirm,
} from "./confirm-copy"

describe("confirm copy", () => {
  test("uses warning tone for archive confirmations", () => {
    const session = archiveSessionConfirm("Blueprint creation request")
    const project = archiveProjectConfirm("Synergy")

    expect(session.title).toBe("Archive session")
    expect(session.description).toContain("Blueprint creation request")
    expect(session.tone).toBe("warning")
    expect(project.title).toBe("Archive project")
    expect(project.description).toContain("Synergy")
    expect(project.tone).toBe("warning")
  })

  test("keeps settings discard cancellation explicit", () => {
    const copy = discardSettingsConfirm("close Settings")

    expect(copy.title).toBe("Discard unsaved changes?")
    expect(copy.cancelLabel).toBe("Keep Editing")
    expect(copy.confirmLabel).toBe("Discard")
    expect(copy.tone).toBe("warning")
  })

  test("uses warning tone for import overwrite conflicts", () => {
    const one = overwriteImportConfirm(1)
    const many = overwriteImportConfirm(3)

    expect(one.title).toBe("Overwrite 1 conflicting key?")
    expect(many.title).toBe("Overwrite 3 conflicting keys?")
    expect(many.confirmLabel).toBe("Overwrite and import")
    expect(many.tone).toBe("warning")
  })

  test("uses danger tone for destructive note, skill, and plugin actions", () => {
    expect(deleteNoteConfirm("Plan").tone).toBe("danger")
    expect(deleteSkillConfirm("browser-control").tone).toBe("danger")
    expect(uninstallPluginConfirm("Example Plugin").tone).toBe("danger")
  })

  test("pluralizes library bulk deletes", () => {
    const memory = deleteLibraryItemsConfirm("memory", 1)
    const experiences = deleteLibraryItemsConfirm("experience", 4)

    expect(memory.title).toBe("Delete memory?")
    expect(memory.confirmLabel).toBe("Delete")
    expect(experiences.title).toBe("Delete 4 experiences?")
    expect(experiences.confirmLabel).toBe("Delete 4")
    expect(experiences.tone).toBe("danger")
  })

  test("separates agenda cancel and delete semantics", () => {
    const cancel = agendaActionConfirm("cancel", "Nightly cleanup")
    const remove = agendaActionConfirm("remove", "Nightly cleanup")

    expect(cancel.title).toBe("Cancel agenda?")
    expect(cancel.confirmLabel).toBe("Cancel agenda")
    expect(cancel.tone).toBe("warning")
    expect(remove.title).toBe("Delete agenda?")
    expect(remove.confirmLabel).toBe("Delete")
    expect(remove.tone).toBe("danger")
  })
})
