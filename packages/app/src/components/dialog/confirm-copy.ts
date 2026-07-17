import type { MessageDescriptor } from "@lingui/core"

export type ConfirmTone = "danger" | "warning" | "neutral"

export interface ConfirmCopy {
  title: MessageDescriptor
  description: MessageDescriptor
  confirmLabel: MessageDescriptor
  cancelLabel?: MessageDescriptor
  tone: ConfirmTone
}

function quoted(value: string | undefined, fallback: string) {
  const label = value?.trim() || fallback
  return `"${label}"`
}

function descriptor(id: string, message: string, values: Record<string, unknown>): MessageDescriptor {
  return { id, message, values }
}

export function archiveSessionConfirm(title: string | undefined): ConfirmCopy {
  const name = title?.trim() || "Untitled session"
  return {
    title: { id: "confirm.archiveSession.title", message: "Archive session" },
    description: descriptor(
      "confirm.archiveSession.desc",
      "Archive {name}? The session will be hidden from active lists and its data preserved.",
      { name: quoted(name, "Untitled session") },
    ),
    confirmLabel: { id: "confirm.archiveSession.confirm", message: "Archive" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "warning",
  }
}

export function archiveProjectConfirm(scopeLabel: string | undefined): ConfirmCopy {
  const name = scopeLabel?.trim() || "Untitled project"
  return {
    title: { id: "confirm.archiveProject.title", message: "Archive project" },
    description: descriptor(
      "confirm.archiveProject.desc",
      "Archive {name}? The project will be hidden from the sidebar and its data preserved.",
      { name: quoted(name, "Untitled project") },
    ),
    confirmLabel: { id: "confirm.archiveProject.confirm", message: "Archive" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "warning",
  }
}

export function leaveWorktreeConfirm(title: string | undefined): ConfirmCopy {
  const name = title?.trim() || "this session"
  return {
    title: { id: "confirm.leaveWorktree.title", message: "Leave worktree?" },
    description: descriptor(
      "confirm.leaveWorktree.desc",
      "Return {name} to the main checkout? The worktree will stay on disk and can be re-entered later.",
      { name: quoted(name, "this session") },
    ),
    confirmLabel: { id: "confirm.leaveWorktree.confirm", message: "Leave worktree" },
    cancelLabel: { id: "confirm.leaveWorktree.cancel", message: "Stay in worktree" },
    tone: "warning",
  }
}

export function discardSettingsConfirm(): ConfirmCopy {
  return {
    title: { id: "confirm.discardSettings.title", message: "Discard unsaved changes?" },
    description: {
      id: "confirm.discardSettings.desc",
      message: "You have unsaved changes for Settings. Discard them and close Settings?",
    },
    confirmLabel: { id: "confirm.discardSettings.confirm", message: "Discard" },
    cancelLabel: { id: "confirm.discardSettings.cancel", message: "Keep Editing" },
    tone: "warning",
  }
}

export function deleteNoteConfirm(title: string | undefined): ConfirmCopy {
  const name = title?.trim() || "Untitled note"
  return {
    title: { id: "confirm.deleteNote.title", message: "Delete note?" },
    description: descriptor("confirm.deleteNote.desc", "Delete {name}? This note will be removed permanently.", {
      name: quoted(name, "Untitled note"),
    }),
    confirmLabel: { id: "confirm.deleteNote.confirm", message: "Delete" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "danger",
  }
}

export function archiveNoteConfirm(count: number): ConfirmCopy {
  return {
    title:
      count === 1
        ? { id: "confirm.archiveNote.title.single", message: "Archive note?" }
        : descriptor("confirm.archiveNote.title.plural", "Archive {count} notes?", { count }),
    description:
      count === 1
        ? {
            id: "confirm.archiveNote.desc.single",
            message: "This note will be hidden from the active list. You can restore it from the Archived view.",
          }
        : descriptor(
            "confirm.archiveNote.desc.plural",
            "These {count} notes will be hidden from the active list. You can restore them from the Archived view.",
            { count },
          ),
    confirmLabel:
      count === 1
        ? { id: "confirm.archiveNote.confirm.single", message: "Archive" }
        : descriptor("confirm.archiveNote.confirm.plural", "Archive {count}", { count }),
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "warning",
  }
}

export function unarchiveNoteConfirm(count: number): ConfirmCopy {
  return {
    title:
      count === 1
        ? { id: "confirm.unarchiveNote.title.single", message: "Restore note?" }
        : descriptor("confirm.unarchiveNote.title.plural", "Restore {count} notes?", { count }),
    description:
      count === 1
        ? { id: "confirm.unarchiveNote.desc.single", message: "This note will be moved back to the active list." }
        : descriptor(
            "confirm.unarchiveNote.desc.plural",
            "These {count} notes will be moved back to the active list.",
            {
              count,
            },
          ),
    confirmLabel:
      count === 1
        ? { id: "confirm.unarchiveNote.confirm.single", message: "Restore" }
        : descriptor("confirm.unarchiveNote.confirm.plural", "Restore {count}", { count }),
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "neutral",
  }
}

export function deleteArchivedNoteConfirm(count: number): ConfirmCopy {
  return {
    title:
      count === 1
        ? { id: "confirm.deleteArchivedNote.title.single", message: "Delete archived note?" }
        : descriptor("confirm.deleteArchivedNote.title.plural", "Delete {count} archived notes?", { count }),
    description:
      count === 1
        ? {
            id: "confirm.deleteArchivedNote.desc.single",
            message: "This note will be removed permanently. This cannot be undone.",
          }
        : descriptor(
            "confirm.deleteArchivedNote.desc.plural",
            "These {count} notes will be removed permanently. This cannot be undone.",
            { count },
          ),
    confirmLabel:
      count === 1
        ? { id: "confirm.deleteArchivedNote.confirm.single", message: "Delete" }
        : descriptor("confirm.deleteArchivedNote.confirm.plural", "Delete {count}", { count }),
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "danger",
  }
}

export function restoreArchivedSessionConfirm(count: number, title?: string): ConfirmCopy {
  const name = title?.trim() || "Untitled session"
  return {
    title:
      count === 1
        ? { id: "confirm.restoreArchivedSession.title.single", message: "Restore archived session?" }
        : descriptor("confirm.restoreArchivedSession.title.plural", "Restore {count} archived sessions?", { count }),
    description:
      count === 1
        ? descriptor(
            "confirm.restoreArchivedSession.desc.single",
            "{name} will be moved back to active session lists.",
            { name: quoted(name, "Untitled session") },
          )
        : descriptor(
            "confirm.restoreArchivedSession.desc.plural",
            "These {count} sessions will be moved back to active session lists.",
            { count },
          ),
    confirmLabel:
      count === 1
        ? { id: "confirm.restoreArchivedSession.confirm.single", message: "Restore" }
        : descriptor("confirm.restoreArchivedSession.confirm.plural", "Restore {count}", { count }),
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "neutral",
  }
}

export function deleteArchivedSessionConfirm(count: number, title?: string): ConfirmCopy {
  const name = title?.trim() || "Untitled session"
  return {
    title:
      count === 1
        ? { id: "confirm.deleteArchivedSession.title.single", message: "Delete archived session?" }
        : descriptor("confirm.deleteArchivedSession.title.plural", "Delete {count} archived sessions?", { count }),
    description:
      count === 1
        ? descriptor(
            "confirm.deleteArchivedSession.desc.single",
            "Delete {name} permanently? This removes the session, messages, history, and associated data. This cannot be undone.",
            { name: quoted(name, "Untitled session") },
          )
        : descriptor(
            "confirm.deleteArchivedSession.desc.plural",
            "Delete these {count} archived sessions permanently? This removes their messages, history, and associated data. This cannot be undone.",
            { count },
          ),
    confirmLabel:
      count === 1
        ? { id: "confirm.deleteArchivedSession.confirm.single", message: "Delete permanently" }
        : descriptor("confirm.deleteArchivedSession.confirm.plural", "Delete {count} permanently", { count }),
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "danger",
  }
}

export function overwriteImportConfirm(conflictCount: number): ConfirmCopy {
  return {
    title: descriptor(
      "confirm.overwriteImport.title",
      "Overwrite {conflictCount, plural, one {# conflicting key} other {# conflicting keys}}?",
      { conflictCount },
    ),
    description: {
      id: "confirm.overwriteImport.desc",
      message: "Existing config values for the selected domains will be replaced by the import.",
    },
    confirmLabel: { id: "confirm.overwriteImport.confirm", message: "Overwrite and import" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "warning",
  }
}

export type AgendaConfirmAction = "cancel" | "remove"

export function agendaActionConfirm(action: AgendaConfirmAction, title: string | undefined): ConfirmCopy {
  const name = title?.trim() || "Untitled agenda"
  if (action === "cancel") {
    return {
      title: { id: "confirm.agendaAction.cancel.title", message: "Cancel agenda?" },
      description: descriptor(
        "confirm.agendaAction.cancel.desc",
        "Cancel {name}? It will stop future runs and preserve its history.",
        { name: quoted(name, "Untitled agenda") },
      ),
      confirmLabel: { id: "confirm.agendaAction.cancel.confirm", message: "Cancel agenda" },
      cancelLabel: { id: "app.cancel", message: "Cancel" },
      tone: "warning",
    }
  }
  return {
    title: { id: "confirm.agendaAction.delete.title", message: "Delete agenda?" },
    description: descriptor(
      "confirm.agendaAction.delete.desc",
      "Delete {name} and its run history? This cannot be undone.",
      { name: quoted(name, "Untitled agenda") },
    ),
    confirmLabel: { id: "confirm.agendaAction.delete.confirm", message: "Delete" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "danger",
  }
}

export type LibraryConfirmKind = "memory" | "experience"

export function deleteLibraryItemsConfirm(kind: LibraryConfirmKind, count: number): ConfirmCopy {
  const values = { kind, count }
  return {
    title:
      count === 1
        ? descriptor(
            "confirm.deleteLibrary.title.single",
            "Delete {kind, select, memory {memory} experience {experience} other {item}}?",
            values,
          )
        : descriptor(
            "confirm.deleteLibrary.title.plural",
            "Delete {count} {kind, select, memory {memories} experience {experiences} other {items}}?",
            values,
          ),
    description:
      count === 1
        ? descriptor(
            "confirm.deleteLibrary.desc.single",
            "This {kind, select, memory {memory} experience {experience} other {item}} will be removed from the library. This cannot be undone.",
            values,
          )
        : descriptor(
            "confirm.deleteLibrary.desc.plural",
            "These {count} {kind, select, memory {memories} experience {experiences} other {items}} will be removed from the library. This cannot be undone.",
            values,
          ),
    confirmLabel:
      count === 1
        ? { id: "confirm.deleteLibrary.confirm.single", message: "Delete" }
        : descriptor("confirm.deleteLibrary.confirm.plural", "Delete {count}", { count }),
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "danger",
  }
}

export function deleteSkillConfirm(name: string | undefined): ConfirmCopy {
  const label = name?.trim() || "Untitled skill"
  return {
    title: { id: "confirm.deleteSkill.title", message: "Delete skill?" },
    description: descriptor("confirm.deleteSkill.desc", "Delete {name} from disk? This cannot be undone.", {
      name: quoted(label, "Untitled skill"),
    }),
    confirmLabel: { id: "confirm.deleteSkill.confirm", message: "Delete" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "danger",
  }
}

export function uninstallPluginConfirm(name: string | undefined): ConfirmCopy {
  const label = name?.trim() || "this plugin"
  return {
    title: { id: "confirm.uninstallPlugin.title", message: "Uninstall plugin?" },
    description: descriptor(
      "confirm.uninstallPlugin.desc",
      "Uninstall {name}? It will be removed from this Synergy install.",
      { name: quoted(label, "this plugin") },
    ),
    confirmLabel: { id: "confirm.uninstallPlugin.confirm", message: "Uninstall" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "danger",
  }
}

export function reencodeExperienceConfirm(kind: "intent" | "script", count: number): ConfirmCopy {
  const values = { kind, count }
  return {
    title: descriptor(
      "confirm.reencodeExperience.title",
      "Re-encode {kind, select, intent {intent} script {script} other {experience}} records?",
      values,
    ),
    description: descriptor(
      "confirm.reencodeExperience.desc",
      "Re-encode all {count} {kind, select, intent {intent} script {script} other {experience}} records? This will make LLM calls and may take several minutes.",
      values,
    ),
    confirmLabel: { id: "confirm.reencodeExperience.confirm", message: "Re-encode" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "warning",
  }
}

export function cancelReencodeConfirm(completed: number, total: number): ConfirmCopy {
  return {
    title: { id: "confirm.cancelReencode.title", message: "Cancel re-encoding?" },
    description: descriptor(
      "confirm.cancelReencode.desc",
      "Cancel after {completed} of {total} records? Completed updates will be kept and unfinished records can be retried later.",
      { completed, total },
    ),
    confirmLabel: { id: "confirm.cancelReencode.confirm", message: "Cancel re-encoding" },
    cancelLabel: { id: "confirm.cancelReencode.cancel", message: "Keep running" },
    tone: "warning",
  }
}

export function deleteWorktreeConfirm(input: { name?: string; dirty?: boolean; bindings?: string[] }): ConfirmCopy {
  const label = input.name?.trim() || "Untitled worktree"
  const bindings = input.bindings ?? []
  return {
    title: input.dirty
      ? { id: "confirm.deleteWorktree.title.dirty", message: "Force-remove dirty worktree?" }
      : { id: "confirm.deleteWorktree.title.clean", message: "Delete worktree?" },
    description: descriptor(
      "confirm.deleteWorktree.desc",
      "Delete {name}? {bindingCount, plural, =0 {No sessions are currently bound.} one {Bound session {bindingNames} will be moved back to the main checkout first.} other {# bound sessions ({bindingNames}) will be moved back to the main checkout first.}}{dirty, select, yes { This worktree has uncommitted changes; force remove will discard them.} other {}} The worktree directory on disk will be removed. This cannot be undone.",
      {
        name: quoted(label, "Untitled worktree"),
        bindingCount: bindings.length,
        bindingNames: bindings.join(", "),
        dirty: input.dirty ? "yes" : "no",
      },
    ),
    confirmLabel: input.dirty
      ? { id: "confirm.deleteWorktree.confirm.dirty", message: "Force remove" }
      : { id: "confirm.deleteWorktree.confirm.clean", message: "Delete" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "danger",
  }
}
