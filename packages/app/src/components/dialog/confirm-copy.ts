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

export function archiveSessionConfirm(title: string | undefined): ConfirmCopy {
  const name = title?.trim() || "Untitled session"
  return {
    title: { id: "confirm.archiveSession.title", message: "Archive session" },
    description: {
      id: "confirm.archiveSession.desc",
      message: `Archive ${quoted(name, "Untitled session")}? The session will be hidden from active lists and its data preserved.`,
    },
    confirmLabel: { id: "confirm.archiveSession.confirm", message: "Archive" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "warning",
  }
}

export function archiveProjectConfirm(scopeLabel: string | undefined): ConfirmCopy {
  const name = scopeLabel?.trim() || "Untitled project"
  return {
    title: { id: "confirm.archiveProject.title", message: "Archive project" },
    description: {
      id: "confirm.archiveProject.desc",
      message: `Archive ${quoted(name, "Untitled project")}? The project will be hidden from the sidebar and its data preserved.`,
    },
    confirmLabel: { id: "confirm.archiveProject.confirm", message: "Archive" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "warning",
  }
}

export function leaveWorktreeConfirm(title: string | undefined): ConfirmCopy {
  const name = title?.trim() || "this session"
  return {
    title: { id: "confirm.leaveWorktree.title", message: "Leave worktree?" },
    description: {
      id: "confirm.leaveWorktree.desc",
      message: `Return ${quoted(name, "this session")} to the main checkout? The worktree will stay on disk and can be re-entered later.`,
    },
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
    description: {
      id: "confirm.deleteNote.desc",
      message: `Delete ${quoted(name, "Untitled note")}? This note will be removed permanently.`,
    },
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
        : { id: "confirm.archiveNote.title.plural", message: `Archive ${count} notes?` },
    description:
      count === 1
        ? {
            id: "confirm.archiveNote.desc.single",
            message: "This note will be hidden from the active list. You can restore it from the Archived view.",
          }
        : {
            id: "confirm.archiveNote.desc.plural",
            message: `These ${count} notes will be hidden from the active list. You can restore them from the Archived view.`,
          },
    confirmLabel:
      count === 1
        ? { id: "confirm.archiveNote.confirm.single", message: "Archive" }
        : { id: "confirm.archiveNote.confirm.plural", message: `Archive ${count}` },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "warning",
  }
}

export function unarchiveNoteConfirm(count: number): ConfirmCopy {
  return {
    title:
      count === 1
        ? { id: "confirm.unarchiveNote.title.single", message: "Restore note?" }
        : { id: "confirm.unarchiveNote.title.plural", message: `Restore ${count} notes?` },
    description:
      count === 1
        ? { id: "confirm.unarchiveNote.desc.single", message: "This note will be moved back to the active list." }
        : {
            id: "confirm.unarchiveNote.desc.plural",
            message: `These ${count} notes will be moved back to the active list.`,
          },
    confirmLabel:
      count === 1
        ? { id: "confirm.unarchiveNote.confirm.single", message: "Restore" }
        : { id: "confirm.unarchiveNote.confirm.plural", message: `Restore ${count}` },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "neutral",
  }
}

export function deleteArchivedNoteConfirm(count: number): ConfirmCopy {
  return {
    title:
      count === 1
        ? { id: "confirm.deleteArchivedNote.title.single", message: "Delete archived note?" }
        : { id: "confirm.deleteArchivedNote.title.plural", message: `Delete ${count} archived notes?` },
    description:
      count === 1
        ? {
            id: "confirm.deleteArchivedNote.desc.single",
            message: "This note will be removed permanently. This cannot be undone.",
          }
        : {
            id: "confirm.deleteArchivedNote.desc.plural",
            message: `These ${count} notes will be removed permanently. This cannot be undone.`,
          },
    confirmLabel:
      count === 1
        ? { id: "confirm.deleteArchivedNote.confirm.single", message: "Delete" }
        : { id: "confirm.deleteArchivedNote.confirm.plural", message: `Delete ${count}` },
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
        : { id: "confirm.restoreArchivedSession.title.plural", message: `Restore ${count} archived sessions?` },
    description:
      count === 1
        ? {
            id: "confirm.restoreArchivedSession.desc.single",
            message: `${quoted(name, "Untitled session")} will be moved back to active session lists.`,
          }
        : {
            id: "confirm.restoreArchivedSession.desc.plural",
            message: `These ${count} sessions will be moved back to active session lists.`,
          },
    confirmLabel:
      count === 1
        ? { id: "confirm.restoreArchivedSession.confirm.single", message: "Restore" }
        : { id: "confirm.restoreArchivedSession.confirm.plural", message: `Restore ${count}` },
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
        : { id: "confirm.deleteArchivedSession.title.plural", message: `Delete ${count} archived sessions?` },
    description:
      count === 1
        ? {
            id: "confirm.deleteArchivedSession.desc.single",
            message: `Delete ${quoted(name, "Untitled session")} permanently? This removes the session, messages, history, and associated data. This cannot be undone.`,
          }
        : {
            id: "confirm.deleteArchivedSession.desc.plural",
            message: `Delete these ${count} archived sessions permanently? This removes their messages, history, and associated data. This cannot be undone.`,
          },
    confirmLabel:
      count === 1
        ? { id: "confirm.deleteArchivedSession.confirm.single", message: "Delete permanently" }
        : { id: "confirm.deleteArchivedSession.confirm.plural", message: `Delete ${count} permanently` },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "danger",
  }
}

export function overwriteImportConfirm(conflictCount: number): ConfirmCopy {
  const noun = conflictCount === 1 ? "key" : "keys"
  return {
    title: { id: "confirm.overwriteImport.title", message: `Overwrite ${conflictCount} conflicting ${noun}?` },
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
      description: {
        id: "confirm.agendaAction.cancel.desc",
        message: `Cancel ${quoted(name, "Untitled agenda")}? It will stop future runs and preserve its history.`,
      },
      confirmLabel: { id: "confirm.agendaAction.cancel.confirm", message: "Cancel agenda" },
      cancelLabel: { id: "app.cancel", message: "Cancel" },
      tone: "warning",
    }
  }
  return {
    title: { id: "confirm.agendaAction.delete.title", message: "Delete agenda?" },
    description: {
      id: "confirm.agendaAction.delete.desc",
      message: `Delete ${quoted(name, "Untitled agenda")} and its run history? This cannot be undone.`,
    },
    confirmLabel: { id: "confirm.agendaAction.delete.confirm", message: "Delete" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "danger",
  }
}

export type LibraryConfirmKind = "memory" | "experience"

export function deleteLibraryItemsConfirm(kind: LibraryConfirmKind, count: number): ConfirmCopy {
  const noun = kind === "memory" ? (count === 1 ? "memory" : "memories") : count === 1 ? "experience" : "experiences"
  return {
    title:
      count === 1
        ? { id: "confirm.deleteLibrary.title.single", message: `Delete ${kind}?` }
        : { id: "confirm.deleteLibrary.title.plural", message: `Delete ${count} ${noun}?` },
    description:
      count === 1
        ? {
            id: "confirm.deleteLibrary.desc.single",
            message: `This ${kind} will be removed from the library. This cannot be undone.`,
          }
        : {
            id: "confirm.deleteLibrary.desc.plural",
            message: `These ${count} ${noun} will be removed from the library. This cannot be undone.`,
          },
    confirmLabel:
      count === 1
        ? { id: "confirm.deleteLibrary.confirm.single", message: "Delete" }
        : { id: "confirm.deleteLibrary.confirm.plural", message: `Delete ${count}` },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "danger",
  }
}

export function deleteSkillConfirm(name: string | undefined): ConfirmCopy {
  const label = name?.trim() || "Untitled skill"
  return {
    title: { id: "confirm.deleteSkill.title", message: "Delete skill?" },
    description: {
      id: "confirm.deleteSkill.desc",
      message: `Delete ${quoted(label, "Untitled skill")} from disk? This cannot be undone.`,
    },
    confirmLabel: { id: "confirm.deleteSkill.confirm", message: "Delete" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "danger",
  }
}

export function uninstallPluginConfirm(name: string | undefined): ConfirmCopy {
  const label = name?.trim() || "this plugin"
  return {
    title: { id: "confirm.uninstallPlugin.title", message: "Uninstall plugin?" },
    description: {
      id: "confirm.uninstallPlugin.desc",
      message: `Uninstall ${quoted(label, "this plugin")}? It will be removed from this Synergy install.`,
    },
    confirmLabel: { id: "confirm.uninstallPlugin.confirm", message: "Uninstall" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "danger",
  }
}

export function reencodeExperienceConfirm(kind: "intent" | "script", count: number): ConfirmCopy {
  return {
    title: { id: "confirm.reencodeExperience.title", message: `Re-encode ${kind} records?` },
    description: {
      id: "confirm.reencodeExperience.desc",
      message: `Re-encode all ${count} ${kind} records? This will make LLM calls and may take several minutes.`,
    },
    confirmLabel: { id: "confirm.reencodeExperience.confirm", message: "Re-encode" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "warning",
  }
}

export function cancelReencodeConfirm(completed: number, total: number): ConfirmCopy {
  return {
    title: { id: "confirm.cancelReencode.title", message: "Cancel re-encoding?" },
    description: {
      id: "confirm.cancelReencode.desc",
      message: `Cancel after ${completed} of ${total} records? Completed updates will be kept and unfinished records can be retried later.`,
    },
    confirmLabel: { id: "confirm.cancelReencode.confirm", message: "Cancel re-encoding" },
    cancelLabel: { id: "confirm.cancelReencode.cancel", message: "Keep running" },
    tone: "warning",
  }
}

export function deleteWorktreeConfirm(input: { name?: string; dirty?: boolean; bindings?: string[] }): ConfirmCopy {
  const label = input.name?.trim() || "Untitled worktree"
  const bindings = input.bindings ?? []
  const bindingText =
    bindings.length === 0
      ? "No sessions are currently bound."
      : bindings.length === 1
        ? `Bound session ${bindings[0]} will be moved back to the main checkout first.`
        : `${bindings.length} bound sessions (${bindings.join(", ")}) will be moved back to the main checkout first.`
  const dirtyText = input.dirty ? " This worktree has uncommitted changes; force remove will discard them." : ""
  return {
    title: input.dirty
      ? { id: "confirm.deleteWorktree.title.dirty", message: "Force-remove dirty worktree?" }
      : { id: "confirm.deleteWorktree.title.clean", message: "Delete worktree?" },
    description: {
      id: "confirm.deleteWorktree.desc",
      message: `Delete ${quoted(label, "Untitled worktree")}? ${bindingText}${dirtyText} The worktree directory on disk will be removed. This cannot be undone.`,
    },
    confirmLabel: input.dirty
      ? { id: "confirm.deleteWorktree.confirm.dirty", message: "Force remove" }
      : { id: "confirm.deleteWorktree.confirm.clean", message: "Delete" },
    cancelLabel: { id: "app.cancel", message: "Cancel" },
    tone: "danger",
  }
}
