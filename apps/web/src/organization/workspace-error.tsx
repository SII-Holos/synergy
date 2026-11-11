import { Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { organizationWorkspaceMessages as messages } from "./workspace-messages"

export function organizationErrorMessage(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined
  if (code === "REVISION_CONFLICT") return messages.conflict
  if (code === "PERMISSION_DENIED" || code === "AUTHENTICATION_REQUIRED") return messages.forbidden
  if (code === "RUNTIME_OFFLINE") return messages.offline
  if (code === "COMMAND_OUTCOME_UNKNOWN") return messages.unknown
  return messages.failed
}

export function WorkspaceError(props: { error?: unknown; retry?: () => void }) {
  const { _ } = useLingui()
  return (
    <Show when={props.error}>
      {(error) => (
        <div class="organization-workspace-error" role="alert">
          <p>{_(organizationErrorMessage(error()))}</p>
          <Show when={props.retry}>
            <Button onClick={props.retry}>{_(messages.retry)}</Button>
          </Show>
        </div>
      )}
    </Show>
  )
}
