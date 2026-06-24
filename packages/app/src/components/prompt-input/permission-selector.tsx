import type { Accessor } from "solid-js"
import { Show } from "solid-js"
import type { ControlProfileId } from "@/context/input"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { ToolbarSelectorPopover } from "@/components/toolbar-selector"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { PERMISSION_MODES } from "./permission-modes"
import type { PermissionModeVisual } from "./types"

export function PermissionModeSelector(props: {
  working: Accessor<boolean>
  switching: Accessor<boolean>
  activeMode: Accessor<PermissionModeVisual>
  selectedProfile: Accessor<ControlProfileId>
  updateProfile: (profile: ControlProfileId, close?: () => void) => void
}) {
  const sdk = useSDK()
  const sync = useSync()

  return (
    <ToolbarSelectorPopover
      trigger={
        <button
          type="button"
          aria-disabled={props.working() || props.switching()}
          onClick={(event) => {
            if (!props.working() && !props.switching()) return
            event.preventDefault()
            event.stopPropagation()
            if (props.switching()) return
            showToast({
              type: "warning",
              title: "Session is running",
              description: "Stop the session before changing its permission mode.",
            })
          }}
          class="flex items-center gap-1.5 h-7 px-3 rounded-full border border-border-weak-base bg-surface-base transition-colors"
          classList={{
            "opacity-60 cursor-not-allowed": props.working() || props.switching(),
            "hover:bg-surface-raised-base-hover": !props.switching(),
          }}
        >
          <Show
            when={props.switching()}
            fallback={
              <>
                <Icon name={props.activeMode().icon} size="small" class={`shrink-0 ${props.activeMode().iconClass}`} />
                <span class={`text-12-medium whitespace-nowrap ${props.activeMode().iconClass}`}>
                  {props.activeMode().shortLabel}
                </span>
                <Icon name="chevron-down" size="small" class="opacity-70 shrink-0" />
              </>
            }
          >
            <Spinner class="text-icon-base" />
          </Show>
        </button>
      }
      title="Permission mode"
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
                <Icon name={mode.icon} size="small" class={`shrink-0 mt-0.5 ${mode.iconClass}`} />
                <div class="min-w-0 flex-1">
                  <div class="text-13-medium text-text-base">{mode.label}</div>
                  <div class="mt-0.5 text-12-regular text-text-weak leading-snug">{mode.description}</div>
                </div>
              </div>
            )}
          </List>
          <div class="border-t border-border-weak-base/40 mt-1 pt-2 px-2">
            <label class="flex items-start gap-2.5 cursor-pointer py-1">
              <input
                type="checkbox"
                class="mt-0.5 accent-icon-interactive-base"
                checked={(sync.data.config as Record<string, unknown>).auto_classifier === true}
                onChange={(event) => {
                  const enabled = event.currentTarget.checked
                  sdk.client.config
                    .update({ config: { auto_classifier: enabled } as any })
                    .then(() => {
                      showToast({
                        type: "info",
                        title: enabled ? "Auto Mode enabled" : "Auto Mode disabled",
                        description: enabled
                          ? "Safe operations will be auto-allowed by the LLM classifier."
                          : "All permission prompts will require manual approval.",
                      })
                    })
                    .catch(() => {
                      showToast({
                        type: "error",
                        title: "Failed to update Auto Mode",
                      })
                    })
                }}
              />
              <div class="min-w-0 flex-1">
                <div class="text-13-medium text-text-base flex items-center gap-1.5">
                  <Icon name="orbit" size="small" class="text-icon-interactive-base" />
                  Auto Mode (Classifier)
                </div>
                <div class="mt-0.5 text-12-regular text-text-weak leading-snug">
                  LLM auto-allows safe operations. Protected operations still ask.
                </div>
              </div>
            </label>
          </div>
          <Show when={props.working()}>
            <div class="px-3 pb-2 text-11-regular text-text-warning">
              Stop the session before changing permission mode.
            </div>
          </Show>
        </>
      )}
    </ToolbarSelectorPopover>
  )
}
