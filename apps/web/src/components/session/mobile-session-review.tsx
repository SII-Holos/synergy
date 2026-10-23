import { Show, splitProps } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLingui } from "@lingui/solid"
import { SessionReviewTab, type SessionReviewTabProps } from "./session-review-tab"
import { useReviewData, errorText } from "../workspace/review-data"
import { reviewCopy as C } from "../workspace/review-copy"
import { workspace as W } from "@/locales/messages"

export function MobileSessionReview(
  props: Omit<SessionReviewTabProps, "diffs" | "diffState" | "loadDiff"> & { messageID?: string; onClose(): void },
) {
  const { _ } = useLingui()
  const [controls, review] = splitProps(props, ["actions", "onRestoreFile", "onClose"])
  const data = useReviewData({
    source: () => (props.messageID ? "turn" : "session"),
    messageID: () => props.messageID,
    from: () => "HEAD",
    to: () => "HEAD",
  })
  const canRestore = () =>
    data.context()?.recording?.status !== "live" && data.context()?.recording?.status !== "pending"
  return (
    <>
      <Show when={data.comparison.error}>
        <div role="alert" class="px-4 py-2 text-text-weak">
          {errorText(data.comparison.error)}
        </div>
      </Show>
      <div class="flex items-center justify-between px-3">
        <IconButton
          icon={getSemanticIcon("action.close")}
          variant="ghost"
          style={{ width: "44px", height: "44px" }}
          aria-label={_(W.closeWorkspace)}
          onClick={controls.onClose}
        />
        <Button variant="ghost" onClick={data.refresh}>
          {_(C.refresh)}
        </Button>
      </div>
      <Show
        when={data.context()}
        fallback={
          <Show when={data.comparison.loading}>
            <div role="status" class="px-4 py-2 text-text-weak">
              {_(C.loading)}
            </div>
          </Show>
        }
      >
        <SessionReviewTab
          {...review}
          diffs={data.rows}
          comparisonKey={data.key()}
          actions={canRestore() ? controls.actions : undefined}
          onRestoreFile={canRestore() ? controls.onRestoreFile : undefined}
          diffState={() => data.context()?.recording}
          loadDiff={async (row, signal, retry) => {
            const content = await data.load(row, { signal, retry })
            if (!content) throw new Error(_(C.contentUnavailable))
            return content.diff
          }}
        />
      </Show>
    </>
  )
}
