export const environmentCopy = {
  title: { id: "environment.dialog.title", message: "Choose Environment" },
  description: {
    id: "environment.dialog.description",
    message: "Choose where commands run. Compute starts only when needed; Workspace files are stored separately.",
  },
  none: { id: "environment.dialog.none", message: "No execution Environment" },
  default: { id: "environment.dialog.default", message: "Use configured default" },
  profiles: { id: "environment.dialog.profiles", message: "Available profiles" },
  existing: { id: "environment.dialog.existing", message: "Existing Environments" },
  loading: { id: "environment.dialog.loading", message: "Loading Environments…" },
  empty: { id: "environment.dialog.empty", message: "No Environments in this project." },
  reload: { id: "environment.dialog.reload", message: "Reload" },
  choose: { id: "environment.dialog.choose", message: "Use Environment" },
  close: { id: "environment.dialog.close", message: "Close" },
  failed: {
    id: "environment.dialog.failed",
    message: "The Environment could not be updated. Reload its state and try again.",
  },
  state: {
    id: "environment.dialog.state",
    message:
      "{state, select, idle {Not allocated} allocating {Starting} ready {Ready} releasing {Saving and releasing} unavailable {Needs recovery} other {Unavailable}}",
  },
  activity: { id: "environment.dialog.activity", message: "Execution activity" },
  activityLoading: { id: "environment.dialog.activityLoading", message: "Loading activity…" },
  activeUses: {
    id: "environment.dialog.activeUses",
    message: "{count, plural, =0 {No active uses} one {# active use} other {# active uses}}",
  },
  refresh: { id: "environment.dialog.refresh", message: "Refresh activity" },
  reconcile: { id: "environment.dialog.reconcile", message: "Check connection" },
  release: { id: "environment.dialog.release", message: "Save and release compute" },
  recover: { id: "environment.dialog.recover", message: "Recover result" },
  recoverDescription: {
    id: "environment.dialog.recoverDescription",
    message: "Recovery checks the original operation and retries saving its result. It does not repeat the command.",
  },
  operation: {
    id: "environment.dialog.operation",
    message:
      "{state, select, submitted {Submitted} running {Running} cancel_requested {Cancellation requested} unknown {Result unconfirmed} exited {Saving result} unsaved {Save needs retry} saved {Finishing} completed {Completed} other {Needs recovery}}",
  },
  cancel: { id: "environment.dialog.cancel", message: "Cancel execution" },
  cancelDescription: {
    id: "environment.dialog.cancelDescription",
    message:
      "Request cancellation of this execution and save its changes. It may take time to confirm that all processes have stopped.",
  },
  details: { id: "environment.dialog.details", message: "Resource details" },
} as const
