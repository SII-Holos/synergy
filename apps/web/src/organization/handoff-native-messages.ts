import type { MessageDescriptor } from "@lingui/core"

export const organizationNativeHandoffMessages = {
  existing: { id: "organization.handoff.native.existing", message: "Use an existing local directory" },
  directory: { id: "organization.handoff.native.directory", message: "Existing destination directory" },
  selected: {
    id: "organization.handoff.native.selected",
    message: "The destination project's selected local directory",
  },
  hint: {
    id: "organization.handoff.native.hint",
    message:
      "Keep the destination directory's files. Review the frozen differences before accepting. Neither directory is overwritten.",
  },
  unavailable: {
    id: "organization.handoff.native.unavailable",
    message: "This runtime has no available local directory for this project. Bind a directory there, then refresh.",
  },
  acceptDirectory: { id: "organization.handoff.native.acceptDirectory", message: "Accept this directory choice" },
  waiting: {
    id: "organization.handoff.native.waiting",
    message: "The destination member must review and accept their directory's versions.",
  },
  preview: { id: "organization.handoff.native.preview", message: "Compare the existing directory" },
  previewHint: {
    id: "organization.handoff.native.previewHint",
    message: "Compare the real destination directory with the final frozen source before preparing it.",
  },
  refresh: { id: "organization.handoff.native.refresh", message: "Capture a new comparison" },
  differences: { id: "organization.handoff.native.differences", message: "Directory differences" },
  differenceHint: {
    id: "organization.handoff.native.differenceHint",
    message:
      "The destination keeps its own versions. Source-only files will not be copied; cloud files remain unchanged.",
  },
  showing: { id: "organization.handoff.native.showing", message: "Showing {first}–{last} of {total}" },
  source: { id: "organization.handoff.native.source", message: "Frozen source" },
  target: { id: "organization.handoff.native.target", message: "Existing directory" },
  absent: { id: "organization.handoff.native.absent", message: "Not present" },
  directoryKind: { id: "organization.handoff.native.directoryKind", message: "Directory" },
  linkKind: { id: "organization.handoff.native.linkKind", message: "Symbolic link" },
  fileKind: { id: "organization.handoff.native.fileKind", message: "File" },
  empty: { id: "organization.handoff.native.empty", message: "No differing file entries." },
  mode: { id: "organization.handoff.native.mode", message: "Directory permissions: {source} → {target}" },
  details: { id: "organization.handoff.native.details", message: "Version details" },
  sourceVersion: { id: "organization.handoff.native.sourceVersion", message: "Frozen source version" },
  targetVersion: { id: "organization.handoff.native.targetVersion", message: "Directory version" },
  differenceVersion: { id: "organization.handoff.native.differenceVersion", message: "Comparison version" },
  previous: { id: "organization.handoff.native.previous", message: "Previous page" },
  next: { id: "organization.handoff.native.next", message: "Next page" },
  loading: { id: "organization.handoff.native.loading", message: "Loading differences…" },
  incomplete: {
    id: "organization.handoff.native.incomplete",
    message:
      "The complete comparison contains {total} differences. Browse the pages you need before choosing the destination versions.",
  },
  reviewed: {
    id: "organization.handoff.native.reviewed",
    message: "I have reviewed the differences I need and choose the destination versions.",
  },
  accept: { id: "organization.handoff.native.accept", message: "Use the destination versions" },
  acceptHint: {
    id: "organization.handoff.native.acceptHint",
    message: "Use the files already in {directory}. Neither directory is overwritten; cloud files remain unchanged.",
  },
  accepted: { id: "organization.handoff.native.accepted", message: "These destination versions have been accepted." },
  cleanup: { id: "organization.handoff.native.cleanup", message: "Destination preparation" },
  cleanupHint: {
    id: "organization.handoff.native.cleanupHint",
    message: "Source cancellation does not confirm that the destination released its temporary preparation.",
  },
  checkCleanup: { id: "organization.handoff.native.checkCleanup", message: "Check destination cleanup" },
  cleanupUnknown: {
    id: "organization.handoff.native.cleanupUnknown",
    message: "Destination cleanup is not confirmed. Check its original runtime.",
  },
  cleanupComplete: {
    id: "organization.handoff.native.cleanupComplete",
    message: "The destination preparation has been released.",
  },
  cleanupScope: {
    id: "organization.handoff.native.cleanupScope",
    message: "This check only inspects the original destination. It cannot open the conversation or start work.",
  },
} satisfies Record<string, MessageDescriptor>
