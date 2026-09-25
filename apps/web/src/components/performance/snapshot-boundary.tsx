import { Show, type JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { P } from "./performance-i18n"

export function PerformanceSnapshotBoundary(props: {
  generatedAt?: string
  attemptedAt?: number
  loading: boolean
  error: string | null
  formatTime: (value: string | number) => string
  onRetry: () => void
  children: JSX.Element
}) {
  const { _ } = useLingui()
  return (
    <>
      <Show when={props.generatedAt && (props.error || props.loading)}>
        <div
          class="performance-snapshot-notice"
          classList={{ "performance-snapshot-notice-pending": !props.error }}
          role={props.error ? "alert" : "status"}
        >
          <div class="flex items-start gap-3">
            <Show when={props.error}>
              <Icon name={getSemanticIcon("state.warning")} class="text-icon-warning-base shrink-0" />
            </Show>
            <div class="min-w-0 flex-1">
              <p class="text-14-medium text-text-strong">
                {props.error ? _(P.stale) : _(P.refreshing.id, { time: props.formatTime(props.generatedAt!) })}
              </p>
              <Show when={props.error}>
                <p class="mt-1 text-14-regular text-text-weak">
                  {_(P.staleDescription.id, { time: props.formatTime(props.generatedAt!) })}
                </p>
                <SnapshotErrorDetails error={props.error!} />
              </Show>
            </div>
          </div>
        </div>
      </Show>
      <Show
        when={props.generatedAt}
        fallback={
          <div class="performance-snapshot-empty" role={props.error ? "alert" : "status"}>
            <Show when={props.error}>
              <div class="performance-snapshot-error-icon">
                <Icon name={getSemanticIcon("state.warning")} size="large" class="text-icon-critical-base" />
              </div>
            </Show>
            <h2 class="text-20-medium text-text-strong">
              {props.loading ? _(P.loading) : props.error ? _(P.unavailable) : _(P.empty)}
            </h2>
            <Show when={!props.loading}>
              <p class="text-14-regular text-text-weak">{_(P.unavailableDescription)}</p>
              <Button
                type="button"
                variant="primary"
                size="large"
                class="performance-snapshot-retry"
                onClick={props.onRetry}
              >
                {_(P.retry)}
              </Button>
              <Show when={props.error}>
                <SnapshotErrorDetails error={props.error!} />
              </Show>
              <Show when={props.attemptedAt}>
                <p class="text-12-regular text-text-weaker">
                  {_(P.attemptedAt.id, { time: props.formatTime(props.attemptedAt!) })}
                </p>
              </Show>
            </Show>
          </div>
        }
      >
        {props.children}
      </Show>
    </>
  )
}

export function SnapshotErrorDetails(props: { error: string }) {
  const { _ } = useLingui()
  return (
    <details class="performance-snapshot-error-details">
      <summary class="cursor-pointer text-14-medium text-text-interactive-base">{_(P.errorDetails)}</summary>
      <pre class="mt-2 whitespace-pre-wrap break-words text-12-regular text-text-weak">{props.error}</pre>
    </details>
  )
}
