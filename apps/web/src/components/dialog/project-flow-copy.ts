export const projectFlowCopy = {
  cancel: { id: "project.flow.cancel", message: "Cancel" },
  choose: { id: "project.flow.choose", message: "Choose project" },
  currentProject: { id: "project.flow.currentProject", message: "Project: {name}" },
  description: { id: "project.flow.description", message: "Keep your draft and choose where this task belongs." },
  search: { id: "project.flow.search", message: "Search projects" },
  none: { id: "project.flow.none", message: "No project" },
  noneDescription: { id: "project.flow.noneDescription", message: "Start a task without project files." },
  open: { id: "project.flow.open", message: "Open folder" },
  empty: { id: "project.flow.empty", message: "No matching projects" },
  directoryUnavailable: { id: "project.flow.directoryUnavailable", message: "Directory unavailable" },
  merge: { id: "project.flow.merge", message: "Merge and switch" },
  mergeTitle: { id: "project.flow.mergeTitle", message: "This project already has a draft" },
  mergeDescription: {
    id: "project.flow.mergeDescription",
    message: "Keep the project draft first, then append this draft and its attachments.",
  },
  changed: {
    id: "project.flow.changed",
    message: "The draft changed. Choose the project again to keep your latest edits.",
  },
  failed: { id: "project.flow.failed", message: "Could not switch project" },
  uploading: {
    id: "project.flow.uploading",
    message: "Wait for attachments to finish uploading before changing project.",
  },
  newTask: { id: "project.flow.newTask", message: "Start a new task in another project" },
  unavailableReference: {
    id: "project.flow.unavailableReference",
    message:
      "Some file references belong to another project. Remove or reselect them before sending; your draft has been kept.",
  },
} as const
