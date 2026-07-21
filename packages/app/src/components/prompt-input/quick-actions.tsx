import { createEffect, createSignal, For, Show } from "solid-js"
import type { MessageDescriptor } from "@lingui/core"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { CommandOption } from "@/context/command"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { useLocale } from "@/context/locale"
import { PI } from "./prompt-input-i18n"
import { translateDescriptor } from "@/locales/translate"
import "./quick-actions.css"

type QuickActionBase = {
  icon: SemanticIconTokenName
  label: MessageDescriptor
  description: MessageDescriptor
}

type QuickAction =
  | (QuickActionBase & { type: "ui"; commandId: string })
  | (QuickActionBase & { type: "runtime"; command: string })

type QuickActionGroup = { actions: QuickAction[] }

const ACTION_GROUPS: QuickActionGroup[] = [
  {
    actions: [
      {
        type: "ui",
        icon: "command.undo",
        label: PI.qaUndo,
        description: PI.qaUndoDesc,
        commandId: "session.undo",
      },
      {
        type: "ui",
        icon: "command.redo",
        label: PI.qaRedo,
        description: PI.qaRedoDesc,
        commandId: "session.redo",
      },
      {
        type: "ui",
        icon: "command.compact",
        label: PI.qaCompact,
        description: PI.qaCompactDesc,
        commandId: "session.compact",
      },
    ],
  },
  {
    actions: [
      {
        type: "runtime",
        icon: "command.init",
        label: PI.qaInit,
        description: PI.qaInitDesc,
        command: "init",
      },
      {
        type: "runtime",
        icon: "command.review",
        label: PI.qaReview,
        description: PI.qaReviewDesc,
        command: "review",
      },
      {
        type: "runtime",
        icon: "command.commit",
        label: PI.qaCommit,
        description: PI.qaCommitDesc,
        command: "commit",
      },
      {
        type: "runtime",
        icon: "command.rmslop",
        label: PI.qaRmslop,
        description: PI.qaRmslopDesc,
        command: "rmslop",
      },
    ],
  },
  {
    actions: [
      {
        type: "runtime",
        icon: "notes.main",
        label: PI.qaNote,
        description: PI.qaNoteDesc,
        command: "note",
      },
      {
        type: "runtime",
        icon: "command.continue",
        label: PI.qaContinue,
        description: PI.qaContinueDesc,
        command: "continue",
      },
      {
        type: "runtime",
        icon: "command.audit",
        label: PI.qaAudit,
        description: PI.qaAuditDesc,
        command: "audit",
      },
      {
        type: "runtime",
        icon: "command.start",
        label: PI.qaStart,
        description: PI.qaStartDesc,
        command: "start",
      },
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
  commands?: CommandOption[]
}

export function QuickActions(props: QuickActionsProps) {
  const { controller, i18n } = useLocale()
  const [open, setOpen] = createSignal(false)
  const commandsDisabled = () => props.commandsDisabled ?? props.disabled
  const runtimeCommandsDisabled = () => props.runtimeCommandsDisabled ?? props.disabled
  const translateActionCopy = (descriptor: MessageDescriptor) => {
    controller.activeLocale()
    return translateDescriptor(descriptor, i18n)
  }

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

  const commandOption = (action: QuickAction) =>
    action.type === "ui" ? props.commands?.find((option) => option.id === action.commandId) : undefined

  const actionTooltip = (action: QuickAction) => {
    const option = commandOption(action)
    const title = option?.title ?? translateActionCopy(action.label)
    const description = option?.description ?? translateActionCopy(action.description)
    return (
      <div class="qa-tooltip">
        <span class="qa-tooltip-title">{title}</span>
        <span class="qa-tooltip-description">{description}</span>
      </div>
    )
  }

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
                        <Tooltip placement="left" value={actionTooltip(action)}>
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
                            <Icon name={getSemanticIcon(action.icon)} size="small" />
                            <Show when={action.type === "runtime"}>{translateActionCopy(action.label)}</Show>
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
      <Tooltip placement="top" value={open() ? i18n._(PI.qaClose) : i18n._(PI.qaOpen)}>
        <button
          type="button"
          disabled={props.disabled}
          class="qa-trigger flex items-center justify-center size-6 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base text-icon-weak-base hover:text-icon-base hover:bg-surface-raised-base-hover active:scale-90 transition-all shadow-xs"
          onClick={() => setOpen(!open())}
        >
          <Icon name={open() ? "chevron-down" : "chevron-up"} size="small" />
        </button>
      </Tooltip>
    </div>
  )
}
