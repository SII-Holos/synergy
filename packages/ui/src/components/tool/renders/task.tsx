import { TOOL_MISC_DESC } from "../../tool-title-descriptors"
import { getTaskToolTrigger, parseTaskSubagentSummary } from "../task-info"
import { TaskSubagentDetail, TaskSubagentSteps } from "../task-subagent-detail"
import { createMemo } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useData } from "../../../context"
import { createAutoScroll } from "../../../hooks"
import { BasicTool, useToolResultPresentation } from "../../basic-tool"
import { ToolRegistry } from "../../message-part"

ToolRegistry.register({
  name: "task",
  render(props) {
    const data = useData()
    const view = data.view
    const resultOnly = useToolResultPresentation()
    const { _ } = useLingui()
    const summary = () => props.metadata.summary
    const steps = createMemo(() => parseTaskSubagentSummary(summary()))
    const isBackground = () => props.metadata.background === true
    const trigger = createMemo(() =>
      getTaskToolTrigger(props.input, {
        backgroundLabel: isBackground() ? _(TOOL_MISC_DESC.backgroundTask) : undefined,
      }),
    )

    const autoScroll = createAutoScroll({
      working: () => true,
    })

    const childSessionId = () => props.metadata.sessionId as string | undefined

    const childPermission = createMemo(() => {
      const sessionId = childSessionId()
      if (!sessionId) return undefined
      return view.permissionsFor(sessionId)[0]
    })

    const handleSubtitleClick = () => {
      const sessionId = childSessionId()
      if (sessionId && data.navigateToSession) {
        data.navigateToSession(sessionId)
      }
    }

    if (resultOnly) {
      return (
        <TaskSubagentDetail
          info={{
            agentType: typeof props.input.subagent_type === "string" ? props.input.subagent_type : undefined,
            description: typeof props.input.description === "string" ? props.input.description : undefined,
            background: isBackground(),
            sessionId: childSessionId(),
            summary: summary(),
            running:
              isBackground() ||
              props.status === "pending" ||
              props.status === "running" ||
              props.status === "generating",
          }}
        />
      )
    }

    return (
      <div data-component="tool-part-wrapper" data-permission={!!childPermission()}>
        <BasicTool
          status={props.status}
          metadata={props.metadata}
          time={props.time}
          defaultOpen={true}
          hideDetails={steps().length === 0}
          trigger={trigger()}
          onSubtitleClick={handleSubtitleClick}
        >
          <div
            ref={autoScroll.scrollRef}
            onScroll={autoScroll.handleScroll}
            data-component="tool-output"
            data-scrollable
          >
            <div ref={autoScroll.contentRef}>
              <TaskSubagentSteps summary={summary()} />
            </div>
          </div>
        </BasicTool>
      </div>
    )
  },
})
