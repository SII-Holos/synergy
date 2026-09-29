import { useLingui } from "@lingui/solid"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { createMemo, createSignal, Show } from "solid-js"
import { thinkingChoices } from "@/context/prompt/model-selection"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

const variantDefault = { id: "settings.modelRole.variant.default", message: "Default" }
const variantDesc = { id: "settings.modelRole.variant.desc", message: "Use the provider default" }
const variantOff = { id: "settings.modelRole.variant.off", message: "Off" }
const variantOffDesc = { id: "settings.modelRole.variant.offDesc", message: "Disable thinking" }
const variantRoleDesc = { id: "settings.modelRole.variant.role", message: "Thinking effort" }
const selectVariantLabel = { id: "settings.modelRole.selectVariant", message: "Select thinking effort" }

type ModelVariantOption = {
  key: string
  label: string
  description: string
  value: string
}

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
  const options = createMemo<ModelVariantOption[]>(() =>
    thinkingChoices(props.availableVariants).map((variant) => ({
      key: variant || "default",
      label: variant === "" ? _(variantDefault) : variant === "off" ? _(variantOff) : variant,
      description: variant === "" ? _(variantDesc) : variant === "off" ? _(variantOffDesc) : _(variantRoleDesc),
      value: variant,
    })),
  )
  const current = createMemo(() => options().find((option) => option.value === (props.value ?? "")))
  const label = () => current()?.label ?? props.value ?? _(variantDefault)

  function select(option: ModelVariantOption | undefined) {
    if (!option) return
    props.onChange(option.value)
    setOpen(false)
  }

  const content = () => (
    <>
      <List<ModelVariantOption>
        class="min-h-0 flex-1"
        key={(option) => option.key}
        items={options}
        current={current()}
        filterKeys={["label", "description", "value"]}
        onSelect={select}
      >
        {(option) => (
          <div class="min-w-0 flex flex-col text-left">
            <span class="truncate text-14-medium text-text-base">{option.label}</span>
            <span class="truncate text-12-regular text-text-weak">{option.description}</span>
          </div>
        )}
      </List>
    </>
  )

  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement="bottom-end"
      gutter={8}
      variant="menu"
      class="w-64"
      portalMount={props.popoverLayer}
      title={_(selectVariantLabel)}
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
      {content()}
    </Popover>
  )
}
