import { useLingui } from "@lingui/solid"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { createMemo, createSignal } from "solid-js"
import { Portal } from "solid-js/web"
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
    <KobaltePopover.Content class="z-70 w-64 max-w-[calc(100vw-32px)] max-h-80 rounded-md flex flex-col border border-border-base bg-surface-raised-stronger-non-alpha shadow-lg outline-none overflow-hidden">
      <KobaltePopover.Title class="sr-only">{_(selectVariantLabel)}</KobaltePopover.Title>
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
    </KobaltePopover.Content>
  )

  return (
    <KobaltePopover open={open()} onOpenChange={setOpen} placement="bottom-end" gutter={8}>
      <KobaltePopover.Trigger
        type="button"
        class={props.triggerClass ?? "settings-model-variant"}
        aria-label={`${_(selectVariantLabel)}: ${label()}`}
      >
        <span class="settings-model-variant-label">{label()}</span>
        <Icon name={getSemanticIcon("navigation.collapse")} size="small" class="settings-model-trigger-icon" />
      </KobaltePopover.Trigger>
      <Portal mount={props.popoverLayer}>{content()}</Portal>
    </KobaltePopover>
  )
}
