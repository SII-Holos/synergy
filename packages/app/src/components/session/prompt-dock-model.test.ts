import { describe, expect, test } from "bun:test"
import type { SessionMeta } from "@/composables/use-session-meta"
import type { SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { promptDockBackPath, promptDockBackToParentID, promptDockForkSourceID } from "./prompt-dock-model"
import { selectPromptDockControl } from "./prompt-dock-control-model"
import { subagentFooterSessionStatus } from "./subagent-session-footer-model"

const baseMeta: SessionMeta = {
  source: "web",
  isSubsession: false,
  isCortexSubagent: false,
  parentID: null,
  cortex: undefined,
  isUnattended: false,
  isAgenda: false,
  isReadOnly: false,
  canSelectModel: true,
  showInputBar: true,
  showBackToParent: false,
  workspaceType: "main",
  isWorktree: false,
  workspaceName: "main",
  branch: undefined,
}

describe("prompt dock navigation targets", () => {
  test("uses the parent id as the Back to parent target only when the session meta allows it", () => {
    expect(promptDockBackToParentID({ showBackToParent: true, parentID: "ses_parent" })).toBe("ses_parent")
    expect(promptDockBackToParentID({ showBackToParent: true, parentID: null })).toBeUndefined()
    expect(promptDockBackToParentID({ showBackToParent: false, parentID: "ses_parent" })).toBeUndefined()
  })

  test("hides fork and browser back targets for subsessions", () => {
    expect(promptDockForkSourceID({ ...baseMeta, isSubsession: false }, "ses_source")).toBe("ses_source")
    expect(promptDockForkSourceID({ ...baseMeta, isSubsession: true }, "ses_source")).toBeUndefined()

    expect(promptDockBackPath({ ...baseMeta, isSubsession: false }, "/project/session/ses_previous")).toBe(
      "/project/session/ses_previous",
    )
    expect(promptDockBackPath({ ...baseMeta, isSubsession: true }, "/project/session/ses_previous")).toBeUndefined()
  })
})

describe("subagent footer session ownership", () => {
  test("looks up runtime status by the represented subagent session, not the current route session", () => {
    const parentStatus: SessionStatus = { type: "busy", description: "parent is running" }
    const subagentStatus: SessionStatus = { type: "retry", attempt: 2, message: "subagent retry", next: 0 }

    expect(
      subagentFooterSessionStatus(
        {
          ses_parent: parentStatus,
          ses_subagent: subagentStatus,
        },
        "ses_subagent",
      ),
    ).toBe(subagentStatus)
  })
})

describe("prompt dock control slot", () => {
  test("workflow offer takes priority over session progress", () => {
    expect(
      selectPromptDockControl({
        workflowOfferVisible: true,
        sessionProgressVisible: true,
      }),
    ).toBe("workflow_offer")
  })

  test("session progress is the fallback control", () => {
    expect(
      selectPromptDockControl({
        workflowOfferVisible: false,
        sessionProgressVisible: true,
      }),
    ).toBe("session_progress")
  })

  test("empty control slot stays empty", () => {
    expect(
      selectPromptDockControl({
        workflowOfferVisible: false,
        sessionProgressVisible: false,
      }),
    ).toBeUndefined()
  })
})
