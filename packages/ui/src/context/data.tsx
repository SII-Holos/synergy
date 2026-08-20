import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk/client"
import type {
  CortexTask,
  DagNode,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  FileDiff,
  Todo,
} from "@ericsanchezok/synergy-sdk"
import { createSimpleContext } from "./helper"
import { createSessionDataView } from "./session-data-view"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

export type Data = {
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  permission?: {
    [sessionID: string]: PermissionRequest[]
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
  question?: {
    [sessionID: string]: QuestionRequest[]
  }
  cortex?: CortexTask[]
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
    directory: string
    serverUrl: string
    onPermissionRespond?: PermissionRespondFn
    onNavigateToSession?: NavigateToSessionFn
  }) => {
    return {
      get store() {
        return props.data
      },
      get view() {
        return createSessionDataView(props.data)
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
