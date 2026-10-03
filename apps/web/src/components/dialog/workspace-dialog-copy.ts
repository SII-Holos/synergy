export const workspaceCopy = {
  title: { id: "workspace.dialog.title", message: "Choose a working directory" },
  description: {
    id: "workspace.dialog.description",
    message: "Choose where this session works. Its project, settings and conversation stay the same.",
  },
  none: { id: "workspace.dialog.none", message: "No Workspace" },
  directory: { id: "workspace.dialog.directory", message: "Local directory" },
  search: { id: "workspace.dialog.search", message: "Search directories" },
  manage: { id: "workspace.dialog.manage", message: "Manage" },
  back: { id: "workspace.dialog.back", message: "Back to directories" },
  close: { id: "workspace.dialog.close", message: "Close" },
  current: { id: "workspace.dialog.current", message: "Currently used" },
  main: { id: "workspace.dialog.main", message: "Main directory" },
  useObjects: { id: "workspace.dialog.useObjects", message: "Use this file collection" },
  useNone: { id: "workspace.dialog.useNone", message: "Use no project files" },
  recovery: { id: "workspace.dialog.recovery", message: "The previous directory is unavailable. Choose a directory." },
  changed: { id: "workspace.dialog.changed", message: "The directory changed. Select it again." },
  createStored: { id: "workspace.dialog.createStored", message: "Create stored Workspace" },
  create: { id: "workspace.dialog.create", message: "Create Workspace" },
  name: { id: "workspace.dialog.name", message: "Workspace name" },
  store: { id: "workspace.dialog.store", message: "Storage profile" },
  recoverSaved: { id: "workspace.dialog.recoverSaved", message: "Recover saved copy" },
  recoverDescription: {
    id: "workspace.dialog.recoverDescription",
    message:
      "Create a separate Workspace from the last saved files. Unsaved changes remain on the original. Destination storage profile:",
  },
  register: { id: "workspace.dialog.register", message: "Add directory" },
  reload: { id: "workspace.dialog.reload", message: "Reload" },
  loading: { id: "workspace.dialog.loading", message: "Loading directories…" },
  empty: {
    id: "workspace.dialog.empty",
    message: "No matching directories.",
  },
  unavailable: { id: "workspace.dialog.unavailable", message: "Unavailable" },
  sharing: { id: "workspace.dialog.sharing", message: "Additional writable Workspaces" },
  sharingDescription: {
    id: "workspace.dialog.sharingDescription",
    message:
      "Sessions in this Workspace may also write to the selected Workspaces. Sharing applies directly and is not inherited.",
  },
  saveSharing: { id: "workspace.dialog.saveSharing", message: "Save sharing" },
  sharingEmpty: { id: "workspace.dialog.sharingEmpty", message: "Add another Workspace to share write access." },
  rebind: { id: "workspace.dialog.rebind", message: "Change local binding" },
  rebindDescription: {
    id: "workspace.dialog.rebindDescription",
    message: "All sessions using this Workspace will use the new directory. Existing files stay in place.",
  },
  rebindPath: { id: "workspace.dialog.rebindPath", message: "New local directory" },
  pick: { id: "workspace.dialog.pick", message: "Browse" },
  applyBinding: { id: "workspace.dialog.applyBinding", message: "Rebind Workspace" },
  choose: { id: "workspace.dialog.choose", message: "Use this directory" },
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
