import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk/client"
import type { DagNode, Message, Part, Session, FileDiff, Todo } from "@ericsanchezok/synergy-sdk"
import { createSimpleContext } from "./helper"
import { createSessionDataView, type SessionDataRuntime } from "./session-data-view"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

export type Data = {
  session: Session[]
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  inbox?: {
    [sessionID: string]: SessionInboxItem[]
  }
  todo?: {
    [sessionID: string]: Todo[]
  }
  dag?: {
    [sessionID: string]: DagNode[]
  }
}

export type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "session" | "always" | "reject"
}) => void

export type NavigateToSessionFn = (sessionID: string) => void

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string | null
    serverUrl: string
    /**
     * Session runtime state (status, pending permissions, pending questions,
     * and the global Cortex task list). All of it is keyed by session id or
     * process-wide and lives outside the Scope store, which is evicted as soon
     * as the user switches project, so the host resolves it from its own global
     * index instead of from `data`.
     */
    runtime?: SessionDataRuntime
    onPermissionRespond?: PermissionRespondFn
    onNavigateToSession?: NavigateToSessionFn
  }) => {
    return {
      get store() {
        return props.data
      },
      get view() {
        return createSessionDataView(props.data, props.runtime)
      },
      get directory() {
        return props.directory
      },
      get serverUrl() {
        return props.serverUrl
      },
      respondToPermission: props.onPermissionRespond,
      navigateToSession: props.onNavigateToSession,
    }
  },
})
