export const workspaceCopy = {
  title: { id: "workspace.dialog.title", message: "Choose Workspace" },
  description: {
    id: "workspace.dialog.description",
    message: "Choose where this session works. Its project, settings and conversation stay the same.",
  },
  none: { id: "workspace.dialog.none", message: "No local files" },
  directory: { id: "workspace.dialog.directory", message: "Local directory" },
  search: { id: "workspace.dialog.search", message: "Find a Workspace" },
  register: { id: "workspace.dialog.register", message: "Add directory" },
  reload: { id: "workspace.dialog.reload", message: "Reload" },
  loading: { id: "workspace.dialog.loading", message: "Loading Workspaces…" },
  empty: { id: "workspace.dialog.empty", message: "No matching Workspaces. Add an existing directory to get started." },
  unavailable: { id: "workspace.dialog.unavailable", message: "Unavailable — choose a local directory to rebind" },
  sharing: { id: "workspace.dialog.sharing", message: "Additional writable Workspaces" },
  sharingDescription: {
    id: "workspace.dialog.sharingDescription",
    message:
      "Sessions in this Workspace may also write to the selected directories. Sharing applies directly and is not inherited.",
  },
  saveSharing: { id: "workspace.dialog.saveSharing", message: "Save sharing" },
  sharingEmpty: { id: "workspace.dialog.sharingEmpty", message: "Add another directory to share write access." },
  rebind: { id: "workspace.dialog.rebind", message: "Change local binding" },
  rebindDescription: {
    id: "workspace.dialog.rebindDescription",
    message: "All sessions using this Workspace will use the new directory. Existing files stay in place.",
  },
  rebindPath: { id: "workspace.dialog.rebindPath", message: "New local directory" },
  pick: { id: "workspace.dialog.pick", message: "Browse" },
  applyBinding: { id: "workspace.dialog.applyBinding", message: "Rebind Workspace" },
  choose: { id: "workspace.dialog.choose", message: "Use Workspace" },
  cancel: { id: "workspace.dialog.cancel", message: "Cancel" },
  failed: {
    id: "workspace.dialog.failed",
    message: "The Workspace could not be updated. Reload to review its current state.",
  },
  busy: {
    id: "workspace.dialog.busy",
    message:
      "Switching requires an idle session. Active file operations may also prevent rebinding or changing sharing.",
  },
} as const
