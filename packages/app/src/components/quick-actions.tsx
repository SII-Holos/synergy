import { createEffect, createSignal, For, Show } from "solid-js"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import "./quick-actions.css"

type QuickAction =
  | {
      type: "ui"
      icon: IconName
      label: string
      commandId: string
    }
  | {
      type: "runtime"
      icon: IconName
      label: string
      command: string
    }

type QuickActionGroup = {
  actions: QuickAction[]
}

const ACTION_GROUPS: QuickActionGroup[] = [
  {
    actions: [
      { type: "ui", icon: "undo-2", label: "Undo", commandId: "session.undo" },
      { type: "ui", icon: "redo-2", label: "Redo", commandId: "session.redo" },
      { type: "ui", icon: "minimize", label: "Compact", commandId: "session.compact" },
    ],
  },
  {
    actions: [
      { type: "runtime", icon: "file-text", label: "Init", command: "init" },
      { type: "runtime", icon: "scan-eye", label: "Review", command: "review" },
      { type: "runtime", icon: "git-merge", label: "Commit", command: "commit" },
      { type: "runtime", icon: "sparkles", label: "Rmslop", command: "rmslop" },
    ],
  },
  {
    actions: [
      { type: "runtime", icon: "notebook-pen", label: "Note", command: "note" },
      { type: "runtime", icon: "rocket", label: "Continue", command: "continue" },
      { type: "runtime", icon: "microscope", label: "Audit", command: "audit" },
      { type: "runtime", icon: "zap", label: "Start", command: "start" },
    ],
  },
]

const QUICK_ACTION_COUNT = ACTION_GROUPS.reduce((count, group) => count + group.actions.length, 0)
const quickActionDelay = (index: number) => `${(QUICK_ACTION_COUNT - index - 1) * 30}ms`

const ACTION_GROUPS_WITH_INDEX = ACTION_GROUPS.reduce<Array<Array<QuickAction & { index: number }>>>(
  (groups, group) => {
    const start = groups.reduce((count, items) => count + items.length, 0)
    groups.push(group.actions.map((action, index) => ({ ...action, index: start + index })))
    return groups
  },
  [],
)

interface QuickActionsProps {
  onCommand: (commandId: string) => void
  onRuntimeCommand: (command: string) => void
  disabled?: boolean
  commandsDisabled?: boolean
  runtimeCommandsDisabled?: boolean
  class?: string
}

export function QuickActions(props: QuickActionsProps) {
  const [open, setOpen] = createSignal(false)
  const commandsDisabled = () => props.commandsDisabled ?? props.disabled
  const runtimeCommandsDisabled = () => props.runtimeCommandsDisabled ?? props.disabled

  createEffect(() => {
    if (props.disabled && open()) setOpen(false)
  })

  const runAction = (action: QuickAction) => {
    if (action.type === "ui") {
      props.onCommand(action.commandId)
      return
    }
    props.onRuntimeCommand(action.command)
  }

  const actionDisabled = (action: QuickAction) =>
    action.type === "ui" ? commandsDisabled() : runtimeCommandsDisabled()

  return (
    <div class={props.class ?? "absolute -top-3 right-5 z-20"}>
      <Show when={open()}>
        <div class="qa-cloud absolute bottom-full right-0 mb-1.5">
          <div class="flex flex-col items-end gap-1.5">
            <For each={ACTION_GROUPS_WITH_INDEX}>
              {(group) => (
                <div class="flex flex-wrap items-center justify-end gap-1.5 max-w-80">
                  <For each={group}>
                    {(action) => {
                      const index = action.index
                      return (
                        <Tooltip placement="left" value={action.label}>
                          <button
                            type="button"
                            disabled={actionDisabled(action)}
                            classList={{
                              "qa-bubble": true,
                              "qa-bubble-icon": action.type === "ui",
                              "qa-bubble-pill": action.type === "runtime",
                            }}
                            style={{ "animation-delay": quickActionDelay(index) }}
                            onClick={() => runAction(action)}
                          >
                            <Icon name={action.icon} size="small" />
                            <Show when={action.type === "runtime"}>{action.label}</Show>
                          </button>
                        </Tooltip>
                      )
                    }}
                  </For>
                </div>
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
