import { Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ExecutionPreparationProgress } from "@/context/execution-summary"
import { E } from "./i18n"

export function ExecutionPreparation(props: {
  loading: boolean
  error: boolean
  progress?: ExecutionPreparationProgress
  retained: boolean
  retry: () => void
}) {
  const { _ } = useLingui()
  const message = () => {
    if (props.error) return _(E.error)
    const progress = props.progress
    if (!progress) return _(E.loading)
    if (progress.stage === "parts") return _({ ...E.preparingParts, values: { count: progress.prepared } })
    if (progress.stage === "messages") {
      if (progress.total !== undefined)
        return _({ ...E.preparingMessagesTotal, values: { count: progress.prepared, total: progress.total } })
      return _({ ...E.preparingMessages, values: { count: progress.prepared } })
    }
    return _(E.preparing)
  }
  return (
    <Show when={props.loading || props.error}>
      <div class="execution-feedback" role="status">
        <span>{message()}</span>{" "}
        <Show when={props.retained}>
          <span>{_(E.showingPrevious)}</span>{" "}
        </Show>
        <Show when={props.error}>
          <button type="button" onClick={props.retry}>
            {_(E.retry)}
          </button>
        </Show>
      </div>
    </Show>
  )
}
