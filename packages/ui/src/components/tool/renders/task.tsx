import { createMemo, For, Show } from "solid-js"
import { useData } from "../../../context"
import { createAutoScroll } from "../../../hooks"
import { BasicTool } from "../../basic-tool"
import { Icon } from "../../icon"
import { ToolRegistry, getToolInfo } from "../../message-part"

ToolRegistry.register({
  name: "task",
  render(props) {
    const data = useData()
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
          defaultOpen={true}
          hideDetails={summary().length === 0}
          trigger={{
            icon: "list-todo",
            title: `${props.input.subagent_type || props.tool} Agent`,
            subtitle: props.input.description,
            tags: isBackground() ? [{ label: "background" }] : undefined,
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
                      <span data-slot="task-tool-title">{info.title}</span>
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
