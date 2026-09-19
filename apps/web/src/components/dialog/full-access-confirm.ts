import type { ConfirmCopy } from "./confirm-copy"

export function fullAccessConfirm(): ConfirmCopy {
  return {
    title: { id: "confirm.fullAccess.title", message: "Enable Full Access?" },
    description: {
      id: "confirm.fullAccess.desc",
      message:
        "Full Access removes Synergy's permission checks and workspace sandboxing for the sessions it applies to. Any command the agent runs, and any file it reads or writes, will execute without asking you first. Only use it for work you are prepared to lose or that runs somewhere disposable.",
    },
    confirmLabel: { id: "confirm.fullAccess.confirm", message: "Enable Full Access" },
    cancelLabel: { id: "confirm.fullAccess.cancel", message: "Keep current mode" },
    tone: "danger",
  }
}
