import { createMemo, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { DiffChanges } from "@ericsanchezok/synergy-ui/diff-changes"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"

export function TurnChangeStatus(props: { sessionID: string; onReview(rootID: string): void }) {
  const sync = useSync(),
    sdk = useSDK(),
    { _ } = useLingui()
  const current = createMemo(() => sync.session.currentTurn(props.sessionID))
  const summary = () => current()?.summary
  const incomplete = () => {
    const state = summary()?.diffState
    return !sdk.connected() || state?.status === "error" || (state?.status === "live" && !!state.code)
  }
  const visible = () => {
    const value = summary()
    return (
      value?.diffTotals &&
      (value.diffState?.status === "live" ||
        value.diffState?.status === "pending" ||
        (value.diffState?.status === "error" && !!value.diffRevision)) &&
      (value.diffHasChanges || (value.diffTotals.files > 0 && !incomplete()))
    )
  }
  return (
    <Show when={visible()}>
      <button
        type="button"
        class="turn-change-status"
        data-turn-change-status
        onClick={() => {
          const value = current()
          if (value) props.onReview(value.rootID)
        }}
        title={
          incomplete()
            ? _({
                id: "session.changes.incompleteHint",
                message: "Showing the last recorded changes. Some files or updates may be unavailable.",
              })
            : _({ id: "session.changes.reviewHint", message: "Open this turn’s recorded changes" })
        }
      >
        <Icon name={getSemanticIcon("command.review")} size="small" />
        <span class="turn-change-status-label">
          {incomplete()
            ? _({ id: "session.changes.recorded", message: "Recorded changes" })
            : _({ id: "session.changes.turn", message: "Turn changes" })}
        </span>
        <span class="turn-change-status-count">
          {_({
            id: "session.changes.fileCount",
            message: "{count, plural, one {# file} other {# files}}",
            values: { count: summary()!.diffTotals!.files },
          })}
        </span>
        <DiffChanges changes={summary()!.diffTotals!} />
      </button>
    </Show>
  )
}
