import { useLingui } from "@lingui/solid"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { createMemo, createSignal, Show } from "solid-js"
import { thinkingChoices } from "@/context/prompt/model-selection"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

const variantDefault = { id: "settings.modelRole.variant.default", message: "Default" }
const variantDesc = { id: "settings.modelRole.variant.desc", message: "Use the provider default" }
const variantOff = { id: "settings.modelRole.variant.off", message: "Off" }
const variantOffDesc = { id: "settings.modelRole.variant.offDesc", message: "Disable thinking" }
const variantRoleDesc = { id: "settings.modelRole.variant.role", message: "Thinking effort" }
const selectVariantLabel = { id: "settings.modelRole.selectVariant", message: "Select thinking effort" }

export function ModelVariantPicker(props: {
  value?: string
  availableVariants: string[]
  popoverLayer?: HTMLElement
  onChange: (variant: string) => void
  triggerClass?: string
  appearance?: "toolbar"
}) {
  const { _ } = useLingui()
  const [open, setOpen] = createSignal(false)
  const options = createMemo(() =>
    thinkingChoices(props.availableVariants).map((variant) => ({
      label: variant === "" ? _(variantDefault) : variant === "off" ? _(variantOff) : variant,
      value: variant,
    })),
  )
  const current = createMemo(() => options().find((option) => option.value === (props.value ?? "")))
  const label = () => current()?.label ?? props.value ?? _(variantDefault)

  return (
    <MenuField
      value={props.value ?? ""}
      options={options()}
      onChange={props.onChange}
      ariaLabel={_(selectVariantLabel)}
      open={open()}
      onOpenChange={setOpen}
      placement="bottom-end"
      surfaceClass="w-64!"
      popoverLayer={props.popoverLayer}
      triggerAs={(triggerProps) => (
        <Tooltip
          placement="bottom"
          value={_(selectVariantLabel)}
          open={open() ? false : undefined}
          inactive={props.appearance !== "toolbar"}
        >
          <button
            {...triggerProps}
            type="button"
            class={props.triggerClass ?? "settings-model-variant"}
            aria-label={`${_(selectVariantLabel)}: ${label()}`}
            data-appearance={props.appearance}
          >
            <span class="settings-model-variant-label">{label()}</span>
            <Show when={props.appearance !== "toolbar"}>
              <Icon name={getSemanticIcon("navigation.collapse")} size="small" class="settings-model-trigger-icon" />
            </Show>
          </button>
        </Tooltip>
      )}
    >
      {(option) => (
        <div class="min-w-0 flex flex-col text-left">
          <span class="truncate text-13-medium text-text-base">{option.label}</span>
          <span class="truncate text-12-regular text-text-weak">
            {option.value === "" ? _(variantDesc) : option.value === "off" ? _(variantOffDesc) : _(variantRoleDesc)}
          </span>
        </div>
      )}
    </MenuField>
  )
}
