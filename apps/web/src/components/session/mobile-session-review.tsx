import { Show, splitProps } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useLingui } from "@lingui/solid"
import { SessionReviewTab, type SessionReviewTabProps } from "./session-review-tab"
import { useReviewData, errorText } from "../workspace/review-data"
import { reviewCopy as C } from "../workspace/review-copy"

export function MobileSessionReview(
  props: Omit<SessionReviewTabProps, "diffs" | "diffState" | "loadDiff"> & { messageID?: string },
) {
  const { _ } = useLingui()
  const [restore, review] = splitProps(props, ["actions", "onRestoreFile"])
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
      <div class="flex justify-end px-3">
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
          actions={canRestore() ? restore.actions : undefined}
          onRestoreFile={canRestore() ? restore.onRestoreFile : undefined}
          diffState={() => data.context()?.recording}
          loadDiff={async (row) => {
            const content = await data.load(row)
            if (!content) throw new Error(_(C.contentUnavailable))
            return content.diff
          }}
        />
      </Show>
    </>
  )
}
