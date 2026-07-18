import { TOOL_MISC_DESC } from "../../tool-title-descriptors"
import { createMemo, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useData } from "../../../context"
import { createAutoScroll } from "../../../hooks"
import { BasicTool } from "../../basic-tool"
import { Icon } from "../../icon"
import type { MessageDescriptor } from "@lingui/core"
import { ToolRegistry, getToolInfo } from "../../message-part"

function resolveTitle(title: string | MessageDescriptor, _: (d: MessageDescriptor) => string): string {
  if (typeof title === "string") return title
  return _(title)
}

ToolRegistry.register({
  name: "task",
  render(props) {
    const data = useData()
    const { _ } = useLingui()
    const summary = () =>
      (props.metadata.summary ?? []) as { id: string; tool: string; state: { status: string; title?: string } }[]
    const isBackground = () => props.metadata.background === true

    const autoScroll = createAutoScroll({
      working: () => true,
    })

    const childSessionId = () => props.metadata.sessionId as string | undefined

    const childPermission = createMemo(() => {
      const sessionId = childSessionId()
      if (!sessionId) return undefined
      const permissions = data.store.permission?.[sessionId] ?? []
      return permissions[0]
    })

    const handleSubtitleClick = () => {
      const sessionId = childSessionId()
      if (sessionId && data.navigateToSession) {
        data.navigateToSession(sessionId)
      }
    }

    return (
      <div data-component="tool-part-wrapper" data-permission={!!childPermission()}>
        <BasicTool
          status={props.status}
          metadata={props.metadata}
          time={props.time}
          defaultOpen={true}
          hideDetails={summary().length === 0}
          trigger={{
            icon: "list-todo",
            title: `${props.input.subagent_type || props.tool} Agent`,
            subtitle: props.input.description,
            tags: isBackground() ? [{ label: _(TOOL_MISC_DESC.backgroundTask) }] : undefined,
          }}
          onSubtitleClick={handleSubtitleClick}
        >
          <div
            ref={autoScroll.scrollRef}
            onScroll={autoScroll.handleScroll}
            data-component="tool-output"
            data-scrollable
          >
            <div ref={autoScroll.contentRef} data-component="task-tools">
              <For each={summary()}>
                {(item) => {
                  const info = getToolInfo(item.tool)
                  return (
                    <div data-slot="task-tool-item">
                      <Icon name={info.icon} size="small" />
                      <span data-slot="task-tool-title">{resolveTitle(info.title, _)}</span>
                      <Show when={item.state.title}>
                        <span data-slot="task-tool-subtitle">{item.state.title}</span>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </BasicTool>
      </div>
    )
  },
})
