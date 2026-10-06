import { Show } from "solid-js"
import { ErrorCard } from "@ericsanchezok/synergy-ui/error-card"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { sessionActivityLabel } from "@ericsanchezok/synergy-ui/session-status"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import type { SessionTransitionEntry } from "@/context/session-transition"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import { translateSessionTransitionCopy } from "./session-transition-progress"
import { S } from "./session-i18n"
import "./session-submission.css"
import type { SessionStatus } from "@ericsanchezok/synergy-sdk/client"

export function submissionForRoot(entry: SessionTransitionEntry | undefined, rootID: string, status?: SessionStatus) {
  if (!entry || (entry.handoff?.messageID ?? entry.draft?.messageID) !== rootID) return undefined
  if (entry.progress.phase !== "error" && status?.type === "busy" && status.activity?.rootID === rootID)
    return undefined
  return { activity: entry.progress.activity, failed: entry.progress.phase === "error" }
}

export function SessionSubmissionStatus(props: {
  entry: SessionTransitionEntry
  hideLoading?: boolean
  hideError?: boolean
}) {
  const { i18n } = useLocale()
  const progress = () => props.entry.progress
  const label = () => sessionActivityLabel({ type: "busy", activity: progress().activity }, i18n)
  const error = () =>
    [progress().error?.code, progress().error?.message].filter(Boolean).join(": ") ||
    translateSessionTransitionCopy(progress().description, i18n)
  return (
    <>
      <Show when={progress().phase === "loading" && !props.hideLoading}>
        <div class="session-submission-status" role="status" aria-live="polite" aria-atomic="true">
          <Spinner class="size-3" />
          <span>{label()}</span>
        </div>
      </Show>
      <Show when={progress().phase === "error" && !props.hideError}>
        <ErrorCard
          role="alert"
          summary={translateSessionTransitionCopy(progress().title, i18n)}
          description={translateSessionTransitionCopy(progress().description, i18n)}
          error={error()}
          actions={
            <>
              <Show when={props.entry.actions?.retry}>
                <Button size="small" onClick={() => props.entry.actions?.retry?.()}>
                  {translateDescriptor(progress().retryLabel ?? S.submissionRetry, i18n)}
                </Button>
              </Show>
              <Show when={props.entry.actions?.dismiss}>
                <Button size="small" variant="ghost" onClick={() => props.entry.actions?.dismiss?.()}>
                  {translateDescriptor(progress().dismissLabel ?? S.submissionDismiss, i18n)}
                </Button>
              </Show>
            </>
          }
        />
      </Show>
    </>
  )
}
