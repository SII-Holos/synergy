import { Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { Terminal } from "@/components/terminal"
import { useTerminal } from "@/context/terminal"
import { registerWorkbenchPanel, type WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"

function TerminalWorkbenchContent(props: WorkbenchPanelContentProps) {
  const terminal = useTerminal()
  const pty = createMemo(() => terminal.all().find((item) => item.id === props.tab.resourceId))

  createEffect(() => {
    const id = props.tab.resourceId
    if (!id) return
    if (!pty()) return
    terminal.open(id)
  })

  return (
    <Show
      when={terminal.ready()}
      fallback={
        <div class="flex h-full items-center justify-center text-13-regular text-text-weak">Loading terminal...</div>
      }
    >
      <Show
        when={pty()}
        fallback={
          <div class="flex h-full items-center justify-center text-13-regular text-text-weak">Terminal closed</div>
        }
      >
        {(activePty) => (
          <Terminal
            pty={activePty()}
            onCleanup={terminal.update}
            onGone={() => {
              props.onRequestClose?.()
            }}
          />
        )}
      </Show>
    </Show>
  )
}

export function WorkspaceTerminalTool() {
  const terminal = useTerminal()
  let unregister: VoidFunction | undefined

  onMount(() => {
    unregister = registerWorkbenchPanel({
      id: "terminal",
      label: "Terminal",
      icon: "terminal",
      surface: "bottom",
      cardinality: "multi",
      pluginId: "builtin",
      order: 10,
      component: TerminalWorkbenchContent,
      async createTab() {
        const pty = await terminal.new()
        if (!pty) return undefined
        return {
          id: `terminal:${pty.id}`,
          resourceId: pty.id,
          title: pty.title,
          source: "terminal",
        }
      },
      async onCloseTab(tab) {
        if (!tab.resourceId) return
        if (!terminal.all().some((pty) => pty.id === tab.resourceId)) return
        await terminal.close(tab.resourceId)
      },
      title(tab) {
        if (!tab.resourceId) return tab.title
        return terminal.all().find((pty) => pty.id === tab.resourceId)?.title ?? tab.title
      },
    })
  })

  onCleanup(() => unregister?.())

  return null
}
