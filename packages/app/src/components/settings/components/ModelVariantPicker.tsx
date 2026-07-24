import { useLingui } from "@lingui/solid"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { createMemo, createSignal, Show } from "solid-js"
import { Portal } from "solid-js/web"

const variantDefault = { id: "settings.modelRole.variant.default", message: "Default" }
const variantDesc = { id: "settings.modelRole.variant.desc", message: "Use the role default" }
const variantRoleDesc = { id: "settings.modelRole.variant.role", message: "Role variant" }
const selectVariantLabel = { id: "settings.modelRole.selectVariant", message: "Select model variant" }

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
}) {
  const { _ } = useLingui()
  const [open, setOpen] = createSignal(false)
  const options = createMemo<ModelVariantOption[]>(() => [
    { key: "default", label: _(variantDefault), description: _(variantDesc), value: "" },
    ...props.availableVariants.map((variant) => ({
      key: variant,
      label: variant,
      description: _(variantRoleDesc),
      value: variant,
    })),
  ])
  const current = createMemo(() => options().find((option) => option.value === (props.value ?? "")))

  function select(option: ModelVariantOption | undefined) {
    if (!option) return
    props.onChange(option.value)
    setOpen(false)
  }

  const content = () => (
    <KobaltePopover.Content class="settings-model-variant-popover flex flex-col border border-border-base bg-surface-raised-stronger-non-alpha shadow-lg outline-none overflow-hidden">
      <KobaltePopover.Title class="sr-only">{_(selectVariantLabel)}</KobaltePopover.Title>
      <List<ModelVariantOption>
        class="settings-model-picker-list"
        key={(option) => option.key}
        items={options}
        current={current()}
        filterKeys={["label", "description", "value"]}
        onSelect={select}
      >
        {(option) => (
          <div class="settings-model-option">
            <span class="settings-model-option-title">{option.label}</span>
            <span class="settings-model-option-detail">{option.description}</span>
          </div>
        )}
      </List>
    </KobaltePopover.Content>
  )

  return (
    <Show when={props.availableVariants.length > 0}>
      <KobaltePopover open={open()} onOpenChange={setOpen} placement="bottom-end" gutter={8}>
        <KobaltePopover.Trigger type="button" class="settings-model-variant" aria-label={_(selectVariantLabel)}>
          <span class="settings-model-variant-label">{current()?.label ?? _(variantDefault)}</span>
          <Icon name="chevron-down" size="small" class="settings-model-trigger-icon" />
        </KobaltePopover.Trigger>
        <Show when={props.popoverLayer} fallback={content()}>
          {(layer) => <Portal mount={layer()}>{content()}</Portal>}
        </Show>
      </KobaltePopover>
    </Show>
  )
}
