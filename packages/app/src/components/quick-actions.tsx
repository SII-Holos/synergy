import { createEffect, createSignal, For, Show } from "solid-js"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import "./quick-actions.css"

interface CommandAction {
  icon: IconName
  label: string
  commandId: string
}

const COMMANDS: CommandAction[] = [
  { icon: "undo-2", label: "Undo", commandId: "session.undo" },
  { icon: "redo-2", label: "Redo", commandId: "session.redo" },
  { icon: "minimize", label: "Compact", commandId: "session.compact" },
]

const QUICK_ACTION_COUNT = COMMANDS.length
const quickActionDelay = (index: number) => `${(QUICK_ACTION_COUNT - index - 1) * 30}ms`

interface QuickActionsProps {
  onCommand: (commandId: string) => void
  disabled?: boolean
  commandsDisabled?: boolean
  class?: string
}

export function QuickActions(props: QuickActionsProps) {
  const [open, setOpen] = createSignal(false)
  const commandsDisabled = () => props.commandsDisabled ?? props.disabled

  createEffect(() => {
    if (props.disabled && open()) setOpen(false)
  })

  return (
    <div class={props.class ?? "absolute -top-3 right-5 z-20"}>
      <Show when={open()}>
        <div class="qa-cloud absolute bottom-full right-0 mb-1.5">
          <div class="flex flex-wrap items-center justify-end gap-1.5 max-w-80">
            <For each={COMMANDS}>
              {(action, i) => (
                <Tooltip placement="left" value={action.label}>
                  <button
                    type="button"
                    disabled={commandsDisabled()}
                    class="qa-bubble qa-bubble-icon"
                    style={{ "animation-delay": quickActionDelay(i()) }}
                    onClick={() => props.onCommand(action.commandId)}
                  >
                    <Icon name={action.icon} size="small" />
                  </button>
                </Tooltip>
              )}
            </For>
          </div>
        </div>
      </Show>
      <Tooltip placement="top" value={open() ? "Close quick actions" : "Quick actions"}>
        <button
          type="button"
          disabled={props.disabled}
          class="qa-trigger flex items-center justify-center size-6 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover active:scale-90 transition-all shadow-xs"
          onClick={() => setOpen(!open())}
        >
          <Icon name={open() ? "chevron-down" : "chevron-up"} size="small" />
        </button>
      </Tooltip>
    </div>
  )
}
