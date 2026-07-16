import { describe, expect, test } from "bun:test"
import {
  agendaActionConfirm,
  archiveProjectConfirm,
  archiveSessionConfirm,
  cancelReencodeConfirm,
  deleteLibraryItemsConfirm,
  deleteNoteConfirm,
  deleteSkillConfirm,
  deleteWorktreeConfirm,
  discardSettingsConfirm,
  leaveWorktreeConfirm,
  overwriteImportConfirm,
  uninstallPluginConfirm,
} from "./confirm-copy"

function msg(d: { message?: string }): string {
  return d.message ?? ""
}

describe("confirm copy", () => {
  test("uses warning tone for archive confirmations", () => {
    const session = archiveSessionConfirm("Blueprint creation request")
    const project = archiveProjectConfirm("Synergy")

    expect(msg(session.title)).toBe("Archive session")
    expect(msg(session.description)).toContain("Blueprint creation request")
    expect(session.tone).toBe("warning")
    expect(msg(project.title)).toBe("Archive project")
    expect(msg(project.description)).toContain("Synergy")
    expect(project.tone).toBe("warning")
  })

  test("keeps settings discard cancellation explicit", () => {
    const copy = discardSettingsConfirm()

    expect(msg(copy.title)).toBe("Discard unsaved changes?")
    expect(copy.cancelLabel).toBeDefined()
    expect(msg(copy.cancelLabel!)).toBe("Keep Editing")
    expect(msg(copy.confirmLabel)).toBe("Discard")
    expect(copy.tone).toBe("warning")
  })

  test("confirms leaving a worktree without implying deletion", () => {
    const copy = leaveWorktreeConfirm("Worktree task")

    expect(msg(copy.title)).toBe("Leave worktree?")
    expect(msg(copy.description)).toContain("Worktree task")
    expect(msg(copy.description)).toContain("will stay on disk")
    expect(msg(copy.confirmLabel)).toBe("Leave worktree")
    expect(copy.cancelLabel).toBeDefined()
    expect(msg(copy.cancelLabel!)).toBe("Stay in worktree")
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

    expect(msg(clean.title)).toBe("Delete worktree?")
    expect(msg(clean.description)).toContain("feature-one")
    expect(msg(clean.description)).toContain("2 bound sessions")
    expect(msg(clean.description)).toContain("main checkout")
    expect(msg(clean.confirmLabel)).toBe("Delete")
    expect(clean.tone).toBe("danger")

    expect(msg(dirty.title)).toBe("Force-remove dirty worktree?")
    expect(msg(dirty.description)).toContain("uncommitted changes")
    expect(msg(dirty.confirmLabel)).toBe("Force remove")
    expect(dirty.tone).toBe("danger")
  })

  test("uses warning tone for import overwrite conflicts", () => {
    const one = overwriteImportConfirm(1)
    const many = overwriteImportConfirm(3)

    expect(msg(one.title)).toBe("Overwrite 1 conflicting key?")
    expect(msg(many.title)).toBe("Overwrite 3 conflicting keys?")
    expect(msg(many.confirmLabel)).toBe("Overwrite and import")
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

    expect(msg(memory.title)).toBe("Delete memory?")
    expect(msg(memory.confirmLabel)).toBe("Delete")
    expect(msg(experiences.title)).toBe("Delete 4 experiences?")
    expect(msg(experiences.confirmLabel)).toBe("Delete 4")
    expect(experiences.tone).toBe("danger")
  })

  test("confirms re-encode cancellation without discarding completed updates", () => {
    const copy = cancelReencodeConfirm(3, 10)

    expect(msg(copy.title)).toBe("Cancel re-encoding?")
    expect(msg(copy.description)).toContain("3 of 10")
    expect(msg(copy.description)).toContain("Completed updates will be kept")
    expect(msg(copy.confirmLabel)).toBe("Cancel re-encoding")
    expect(msg(copy.cancelLabel!)).toBe("Keep running")
    expect(copy.tone).toBe("warning")
  })

  test("separates agenda cancel and delete semantics", () => {
    const cancel = agendaActionConfirm("cancel", "Nightly cleanup")
    const remove = agendaActionConfirm("remove", "Nightly cleanup")

    expect(msg(cancel.title)).toBe("Cancel agenda?")
    expect(msg(cancel.confirmLabel)).toBe("Cancel agenda")
    expect(cancel.tone).toBe("warning")
    expect(msg(remove.title)).toBe("Delete agenda?")
    expect(msg(remove.confirmLabel)).toBe("Delete")
    expect(remove.tone).toBe("danger")
  })
})
