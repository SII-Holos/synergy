import type { Accessor } from "solid-js"
import { Show } from "solid-js"
import type { ControlProfileId } from "@/context/input"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { ToolbarSelectorPopover } from "@/components/toolbar-selector"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLocale } from "@/context/locale"
import { PERMISSION_MODES } from "./permission-modes"
import { PI } from "./prompt-input-i18n"
import type { PermissionModeVisual } from "./types"

export function PermissionModeSelector(props: {
  working: Accessor<boolean>
  switching: Accessor<boolean>
  activeMode: Accessor<PermissionModeVisual>
  selectedProfile: Accessor<ControlProfileId>
  updateProfile: (profile: ControlProfileId, close?: () => void) => void
}) {
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)

  return (
    <ToolbarSelectorPopover
      trigger={
        <button
          type="button"
          aria-label={i18n._({ ...PI.permissionModeAria, values: { mode: props.activeMode().label } })}
          aria-disabled={props.working() || props.switching()}
          onClick={(event) => {
            if (!props.working() && !props.switching()) return
            event.preventDefault()
            event.stopPropagation()
            if (props.switching()) return
            showToast({
              type: "warning",
              title: _(PI.permissionRunning),
              description: _(PI.permissionStopBefore),
            })
          }}
          class="prompt-input-toolbar-button prompt-input-compact-control flex items-center gap-1.5 transition-colors"
          classList={{
            "opacity-60 cursor-not-allowed": props.working() || props.switching(),
          }}
        >
          <Show
            when={props.switching()}
            fallback={
              <>
                <Icon
                  name={getSemanticIcon(props.activeMode().icon)}
                  size="small"
                  class={`shrink-0 ${props.activeMode().iconClass}`}
                />
                <span
                  class={`prompt-input-compact-label text-12-medium whitespace-nowrap ${props.activeMode().iconClass}`}
                >
                  {props.activeMode().shortLabel}
                </span>
                <Icon name="chevron-down" size="small" class="prompt-input-compact-chevron opacity-70 shrink-0" />
              </>
            }
          >
            <Spinner class="text-icon-base" />
          </Show>
        </button>
      }
      title={_(PI.permissionMode)}
      contentClass="w-80"
      placement="top-start"
    >
      {(close) => (
        <>
          <List
            class="p-1"
            items={PERMISSION_MODES}
            key={(mode) => mode.id}
            current={PERMISSION_MODES.find((mode) => mode.id === props.selectedProfile())}
            onSelect={(mode) => {
              if (!mode) return
              props.updateProfile(mode.id, close)
            }}
          >
            {(mode) => (
              <div class="flex items-start gap-3 min-w-0 text-left">
                <Icon name={getSemanticIcon(mode.icon)} size="small" class={`shrink-0 mt-0.5 ${mode.iconClass}`} />
                <div class="min-w-0 flex-1">
                  <div class="text-13-medium text-text-base">{mode.label}</div>
                  <div class="mt-0.5 text-12-regular text-text-weak leading-snug">{mode.description}</div>
                </div>
              </div>
            )}
          </List>
          <Show when={props.working()}>
            <div class="px-3 pb-2 text-11-regular text-text-on-warning-base">{_(PI.permissionStopBeforeInline)}</div>
          </Show>
        </>
      )}
    </ToolbarSelectorPopover>
  )
}
