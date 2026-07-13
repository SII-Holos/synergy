import { describe, expect, test } from "bun:test"
import {
  agendaActionConfirm,
  archiveProjectConfirm,
  archiveSessionConfirm,
  deleteLibraryItemsConfirm,
  deleteNoteConfirm,
  deleteSkillConfirm,
  deleteWorktreeConfirm,
  discardSettingsConfirm,
  leaveWorktreeConfirm,
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

  test("confirms leaving a worktree without implying deletion", () => {
    const copy = leaveWorktreeConfirm("Worktree task")

    expect(copy.title).toBe("Leave worktree?")
    expect(copy.description).toContain("Worktree task")
    expect(copy.description).toContain("will stay on disk")
    expect(copy.confirmLabel).toBe("Leave worktree")
    expect(copy.cancelLabel).toBe("Stay in worktree")
    expect(copy.tone).toBe("warning")
  })

  test("confirms worktree deletion and mentions bound sessions", () => {
    const clean = deleteWorktreeConfirm({
      name: "feature-one",
      dirty: false,
      bindings: ["ses_a", "ses_b"],
    })
    const dirty = deleteWorktreeConfirm({
      name: "feature-dirty",
      dirty: true,
      bindings: [],
    })

    expect(clean.title).toBe("Delete worktree?")
    expect(clean.description).toContain("feature-one")
    expect(clean.description).toContain("2 bound sessions")
    expect(clean.description).toContain("main checkout")
    expect(clean.confirmLabel).toBe("Delete")
    expect(clean.tone).toBe("danger")

    expect(dirty.title).toBe("Force-remove dirty worktree?")
    expect(dirty.description).toContain("uncommitted changes")
    expect(dirty.confirmLabel).toBe("Force remove")
    expect(dirty.tone).toBe("danger")
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
