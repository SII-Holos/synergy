import { Show, createEffect, createMemo } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Terminal } from "@/components/terminal"
import { useTerminal } from "@/context/terminal"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { terminal as T } from "@/locales/messages"

export function TerminalWorkbenchContent(props: WorkbenchPanelContentProps) {
  const terminal = useTerminal()
  const lingui = useLingui()
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
        <div class="flex h-full items-center justify-center text-13-regular text-text-weak">
          {lingui._({ id: T.loading.id, message: T.loading.message })}
        </div>
      }
    >
      <Show
        when={pty()}
        fallback={
          <div class="flex h-full items-center justify-center text-13-regular text-text-weak">
            {lingui._({ id: T.closed.id, message: T.closed.message })}
          </div>
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
