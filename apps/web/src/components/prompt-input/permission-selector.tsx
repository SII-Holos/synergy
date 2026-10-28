import type { Accessor } from "solid-js"
import type { MessageDescriptor } from "@lingui/core"
import { createSignal, Show } from "solid-js"
import type { ControlProfileId } from "@/context/input"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { useViewActivity } from "@ericsanchezok/synergy-ui/context/view-activity"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import { PERMISSION_MODES, permissionModeVisual } from "./permission-modes"
import { PI } from "./prompt-input-i18n"
import type { PermissionModeVisual } from "./types"

export function PermissionModeSelector(props: {
  switching: Accessor<boolean>
  activeMode: Accessor<PermissionModeVisual>
  selectedProfile: Accessor<ControlProfileId>
  updateProfile: (profile: ControlProfileId, close?: () => void) => void | Promise<void>
}) {
  const { controller, i18n } = useLocale()
  const active = useViewActivity()
  const [open, setOpen] = createSignal(false)
  const [selecting, setSelecting] = createSignal(false)
  const disabled = () => props.switching() || selecting()
  const translateModeCopy = (descriptor: MessageDescriptor) => {
    controller.activeLocale()
    return translateDescriptor(descriptor, i18n)
  }

  return (
    <MenuField
      value={props.selectedProfile()}
      options={PERMISSION_MODES.map((mode) => ({ value: mode.id, label: translateModeCopy(mode.label) }))}
      onChange={async (value) => {
        setSelecting(true)
        try {
          await props.updateProfile(value, () => setOpen(false))
        } finally {
          setSelecting(false)
        }
      }}
      ariaLabel={i18n._(PI.permissionMode)}
      open={open()}
      onOpenChange={(next) => {
        if (next || !selecting() || !active()) setOpen(next)
      }}
      closeOnChange={false}
      disabled={disabled()}
      triggerAs={(triggerProps) => (
        <button
          {...triggerProps}
          type="button"
          aria-label={i18n._({
            ...PI.permissionModeAria,
            values: { mode: translateModeCopy(props.activeMode().label) },
          })}
          aria-disabled={disabled()}
          class="prompt-input-toolbar-button flex items-center gap-1.5 transition-colors"
          classList={{
            "opacity-60 cursor-not-allowed": disabled(),
            "prompt-input-permission-full-access": props.activeMode().id === "full_access",
          }}
        >
          <Show
            when={props.switching()}
            fallback={
              <Icon
                name={getSemanticIcon(props.activeMode().icon)}
                size="small"
                class={`shrink-0 ${props.activeMode().iconClass}`}
              />
            }
          >
            <Spinner class="text-icon-base size-4 shrink-0" />
          </Show>
          <span class={`text-12-medium whitespace-nowrap ${props.activeMode().iconClass}`}>
            {translateModeCopy(props.activeMode().shortLabel)}
          </span>
        </button>
      )}
      surfaceClass="w-80!"
      placement="top-start"
    >
      {(option) => {
        const mode = permissionModeVisual(option.value)
        return (
          <div class="flex items-start gap-3 min-w-0 text-left">
            <Icon name={getSemanticIcon(mode.icon)} size="small" class={`shrink-0 mt-0.5 ${mode.iconClass}`} />
            <div class="min-w-0 flex-1">
              <div class="text-13-medium text-text-base">{option.label}</div>
              <div class="mt-0.5 text-12-regular text-text-weak leading-snug">
                {translateModeCopy(mode.description)}
              </div>
            </div>
          </div>
        )
      }}
    </MenuField>
  )
}
