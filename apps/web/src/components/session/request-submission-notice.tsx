import { Match, Show, Switch } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { requestErrorMessage } from "@/utils/error"
import type { RequestSubmissionState } from "./request-submission"

const copy = {
  failed: { id: "session.submission.failed", message: "Submission failed." },
  unknown: {
    id: "session.submission.unknown",
    message: "The result could not be confirmed.",
  },
  retry: { id: "session.submission.retry", message: "Retry submission" },
  check: { id: "session.submission.check", message: "Check status" },
  details: { id: "session.submission.details", message: "Error details" },
}

export function RequestSubmissionNotice(props: { state: RequestSubmissionState; onRetry(): void }) {
  const { _ } = useLingui()
  const failed = () => props.state.status === "error" || props.state.status === "unknown"
  return (
    <Show when={failed()}>
      <div class="decision-notice flex flex-col gap-2 px-4 py-3 text-12-regular" role="alert">
        <Switch>
          <Match when={props.state.status === "unknown"}>{_(copy.unknown)}</Match>
          <Match when={props.state.status === "error"}>{_(copy.failed)}</Match>
        </Switch>
        <div>
          <Button variant="secondary" onClick={props.onRetry}>
            {_(props.state.status === "unknown" ? copy.check : copy.retry)}
          </Button>
        </div>
        <Show when={props.state.error}>
          <details>
            <summary class="cursor-pointer">{_(copy.details)}</summary>
            <pre class="whitespace-pre-wrap break-words max-h-32 overflow-auto">
              {requestErrorMessage(props.state.error, _(copy.failed))}
            </pre>
          </details>
        </Show>
      </div>
    </Show>
  )
}
