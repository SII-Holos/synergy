import type { SessionWorkspaceTransitionRequest } from "./worktree-session"
import { DialogIndependentCopy } from "../dialog/dialog-independent-copy"

export function WorktreeEnterConfirmDialog(props: {
  sessionID: string
  directory: string
  onConfirm: (request: SessionWorkspaceTransitionRequest) => void
}) {
  return (
    <DialogIndependentCopy
      source={props.directory}
      onConfirm={(name) =>
        queueMicrotask(() =>
          props.onConfirm({ operation: "enter", sessionID: props.sessionID, directory: props.directory, name }),
        )
      }
    />
  )
}
