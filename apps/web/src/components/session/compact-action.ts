import type { useLocal } from "@/context/local"
import type { useSDK } from "@/context/sdk"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { isSessionCompactionPending, runSessionCompaction, type CompactionNotices } from "./compact-action-core"

export async function compactSessionWithCurrentModel(input: {
  sdk: ReturnType<typeof useSDK>
  local: ReturnType<typeof useLocal>
  sessionID: string | undefined
  notices: CompactionNotices
}) {
  return runSessionCompaction({
    sessionID: input.sessionID,
    model: input.local.model.current(),
    summarize: (request) => input.sdk.client.session.summarize(request),
    notify: showToast,
    notices: input.notices,
  })
}

export { isSessionCompactionPending } from "./compact-action-core"
