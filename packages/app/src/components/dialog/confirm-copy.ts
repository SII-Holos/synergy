import type { JSXElement } from "solid-js"

export type ConfirmTone = "danger" | "warning" | "neutral"

export interface ConfirmCopy {
  title: JSXElement
  description: JSXElement
  confirmLabel: string
  cancelLabel?: string
  tone: ConfirmTone
}

function quoted(value: string | undefined, fallback: string) {
  const label = value?.trim() || fallback
  return `"${label}"`
}

function plural(count: number, singular: string, pluralLabel = `${singular}s`) {
  return count === 1 ? singular : pluralLabel
}

export function archiveSessionConfirm(title: string | undefined): ConfirmCopy {
  return {
    title: "Archive session",
    description: `Archive ${quoted(title, "Untitled session")}? The session will be hidden from active lists and its data preserved.`,
    confirmLabel: "Archive",
    cancelLabel: "Cancel",
    tone: "warning",
  }
}

export function archiveProjectConfirm(scopeLabel: string | undefined): ConfirmCopy {
  return {
    title: "Archive project",
    description: `Archive ${quoted(scopeLabel, "Untitled project")}? The project will be hidden from the sidebar and its data preserved.`,
    confirmLabel: "Archive",
    cancelLabel: "Cancel",
    tone: "warning",
  }
}

export function leaveWorktreeConfirm(title: string | undefined): ConfirmCopy {
  return {
    title: "Leave worktree?",
    description: `Return ${quoted(title, "this session")} to the main checkout? The worktree will stay on disk and can be re-entered later.`,
    confirmLabel: "Leave worktree",
    cancelLabel: "Stay in worktree",
    tone: "warning",
  }
}

export function discardSettingsConfirm(actionLabel: string): ConfirmCopy {
  return {
    title: "Discard unsaved changes?",
    description: `You have unsaved changes for Settings. Discard them and ${actionLabel}?`,
    confirmLabel: "Discard",
    cancelLabel: "Keep Editing",
    tone: "warning",
  }
}

export function deleteNoteConfirm(title: string | undefined): ConfirmCopy {
  return {
    title: "Delete note?",
    description: `Delete ${quoted(title, "Untitled note")}? This note will be removed permanently.`,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    tone: "danger",
  }
}

export function archiveNoteConfirm(count: number): ConfirmCopy {
  return {
    title: count === 1 ? "Archive note?" : `Archive ${count} notes?`,
    description:
      count === 1
        ? "This note will be hidden from the active list. You can restore it from the Archived view."
        : `These ${count} notes will be hidden from the active list. You can restore them from the Archived view.`,
    confirmLabel: count === 1 ? "Archive" : `Archive ${count}`,
    cancelLabel: "Cancel",
    tone: "warning",
  }
}

export function unarchiveNoteConfirm(count: number): ConfirmCopy {
  return {
    title: count === 1 ? "Restore note?" : `Restore ${count} notes?`,
    description:
      count === 1
        ? "This note will be moved back to the active list."
        : `These ${count} notes will be moved back to the active list.`,
    confirmLabel: count === 1 ? "Restore" : `Restore ${count}`,
    cancelLabel: "Cancel",
    tone: "neutral",
  }
}

export function deleteArchivedNoteConfirm(count: number): ConfirmCopy {
  return {
    title: count === 1 ? "Delete archived note?" : `Delete ${count} archived notes?`,
    description:
      count === 1
        ? "This note will be removed permanently. This cannot be undone."
        : `These ${count} notes will be removed permanently. This cannot be undone.`,
    confirmLabel: count === 1 ? "Delete" : `Delete ${count}`,
    cancelLabel: "Cancel",
    tone: "danger",
  }
}

export function restoreArchivedSessionConfirm(count: number, title?: string): ConfirmCopy {
  return {
    title: count === 1 ? "Restore archived session?" : `Restore ${count} archived sessions?`,
    description:
      count === 1
        ? `${quoted(title, "Untitled session")} will be moved back to active session lists.`
        : `These ${count} sessions will be moved back to active session lists.`,
    confirmLabel: count === 1 ? "Restore" : `Restore ${count}`,
    cancelLabel: "Cancel",
    tone: "neutral",
  }
}

export function deleteArchivedSessionConfirm(count: number, title?: string): ConfirmCopy {
  return {
    title: count === 1 ? "Delete archived session?" : `Delete ${count} archived sessions?`,
    description:
      count === 1
        ? `Delete ${quoted(title, "Untitled session")} permanently? This removes the session, messages, history, and associated data. This cannot be undone.`
        : `Delete these ${count} archived sessions permanently? This removes their messages, history, and associated data. This cannot be undone.`,
    confirmLabel: count === 1 ? "Delete permanently" : `Delete ${count} permanently`,
    cancelLabel: "Cancel",
    tone: "danger",
  }
}

export function overwriteImportConfirm(conflictCount: number): ConfirmCopy {
  return {
    title: `Overwrite ${conflictCount} conflicting ${plural(conflictCount, "key")}?`,
    description: "Existing config values for the selected domains will be replaced by the import.",
    confirmLabel: "Overwrite and import",
    cancelLabel: "Cancel",
    tone: "warning",
  }
}

export type AgendaConfirmAction = "cancel" | "remove"

export function agendaActionConfirm(action: AgendaConfirmAction, title: string | undefined): ConfirmCopy {
  if (action === "cancel") {
    return {
      title: "Cancel agenda?",
      description: `Cancel ${quoted(title, "Untitled agenda")}? It will stop future runs and preserve its history.`,
      confirmLabel: "Cancel agenda",
      cancelLabel: "Cancel",
      tone: "warning",
    }
  }

  return {
    title: "Delete agenda?",
    description: `Delete ${quoted(title, "Untitled agenda")} and its run history? This cannot be undone.`,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    tone: "danger",
  }
}

export function cancelWorkflowRunConfirm(title: string | undefined): ConfirmCopy {
  return {
    title: "Cancel workflow run?",
    description: `Cancel ${quoted(title, "Untitled workflow run")}? Its seats, tasks, and loops will stop, and the run cannot be resumed.`,
    confirmLabel: "Cancel run",
    cancelLabel: "Keep running",
    tone: "danger",
  }
}

export type LibraryConfirmKind = "memory" | "experience"

export function deleteLibraryItemsConfirm(kind: LibraryConfirmKind, count: number): ConfirmCopy {
  const noun = plural(count, kind, kind === "memory" ? "memories" : "experiences")
  return {
    title: count === 1 ? `Delete ${kind}?` : `Delete ${count} ${noun}?`,
    description:
      count === 1
        ? `This ${kind} will be removed from the library. This cannot be undone.`
        : `These ${count} ${noun} will be removed from the library. This cannot be undone.`,
    confirmLabel: count === 1 ? "Delete" : `Delete ${count}`,
    cancelLabel: "Cancel",
    tone: "danger",
  }
}

export function deleteSkillConfirm(name: string | undefined): ConfirmCopy {
  return {
    title: "Delete skill?",
    description: `Delete ${quoted(name, "Untitled skill")} from disk? This cannot be undone.`,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    tone: "danger",
  }
}

export function uninstallPluginConfirm(name: string | undefined): ConfirmCopy {
  return {
    title: "Uninstall plugin?",
    description: `Uninstall ${quoted(name, "this plugin")}? It will be removed from this Synergy install.`,
    confirmLabel: "Uninstall",
    cancelLabel: "Cancel",
    tone: "danger",
  }
}

export function reencodeExperienceConfirm(kind: "intent" | "script", count: number): ConfirmCopy {
  return {
    title: `Re-encode ${kind} records?`,
    description: `Re-encode all ${count} ${kind} records? This will make LLM calls and may take several minutes.`,
    confirmLabel: "Re-encode",
    cancelLabel: "Cancel",
    tone: "warning",
  }
}

export function deleteWorktreeConfirm(input: { name?: string; dirty?: boolean; bindings?: string[] }): ConfirmCopy {
  const label = quoted(input.name, "Untitled worktree")
  const bindings = input.bindings ?? []
  const bindingText =
    bindings.length === 0
      ? "No sessions are currently bound."
      : bindings.length === 1
        ? `Bound session ${bindings[0]} will be moved back to the main checkout first.`
        : `${bindings.length} bound sessions (${bindings.join(", ")}) will be moved back to the main checkout first.`
  const dirtyText = input.dirty ? " This worktree has uncommitted changes; force remove will discard them." : ""
  return {
    title: input.dirty ? "Force-remove dirty worktree?" : "Delete worktree?",
    description: `Delete ${label}? ${bindingText}${dirtyText} The worktree directory on disk will be removed. This cannot be undone.`,
    confirmLabel: input.dirty ? "Force remove" : "Delete",
    cancelLabel: "Cancel",
    tone: "danger",
  }
}
