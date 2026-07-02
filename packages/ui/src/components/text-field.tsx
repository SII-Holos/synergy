import { TextField as Kobalte } from "@kobalte/core/text-field"
import { Show, splitProps } from "solid-js"
import type { ComponentProps } from "solid-js"
import { createCopyController } from "./clipboard"
import { IconButton } from "./icon-button"
import { Tooltip } from "./tooltip"

export interface TextFieldProps
  extends ComponentProps<typeof Kobalte.Input>,
    Partial<
      Pick<
        ComponentProps<typeof Kobalte>,
        | "name"
        | "defaultValue"
        | "value"
        | "onChange"
        | "onKeyDown"
        | "validationState"
        | "required"
        | "disabled"
        | "readOnly"
      >
    > {
  label?: string
  hideLabel?: boolean
  description?: string
  error?: string
  variant?: "normal" | "ghost"
  copyable?: boolean
  multiline?: boolean
}

export function TextField(props: TextFieldProps) {
  const [local, others] = splitProps(props, [
    "name",
    "defaultValue",
    "value",
    "onChange",
    "onKeyDown",
    "validationState",
    "required",
    "disabled",
    "readOnly",
    "class",
    "label",
    "hideLabel",
    "description",
    "error",
    "variant",
    "copyable",
    "multiline",
  ])
  const copy = createCopyController({
    text: () => `${local.value ?? local.defaultValue ?? ""}`,
    copyLabel: "Copy to clipboard",
    failureDescription: "Unable to copy the field value.",
  })

  function handleClick() {
    if (local.copyable) void copy.copy()
  }

  return (
    <Kobalte
      data-component="input"
      data-variant={local.variant || "normal"}
      name={local.name}
      defaultValue={local.defaultValue}
      value={local.value}
      onChange={local.onChange}
      onKeyDown={local.onKeyDown}
      onClick={handleClick}
      required={local.required}
      disabled={local.disabled}
      readOnly={local.readOnly}
      validationState={local.validationState}
    >
      <Show when={local.label}>
        <Kobalte.Label data-slot="input-label" classList={{ "sr-only": local.hideLabel }}>
          {local.label}
        </Kobalte.Label>
      </Show>
      <div data-slot="input-wrapper">
        <Show
          when={local.multiline}
          fallback={<Kobalte.Input {...others} data-slot="input-input" class={local.class} />}
        >
          <Kobalte.TextArea {...others} autoResize data-slot="input-input" class={local.class} />
        </Show>
        <Show when={local.copyable}>
          <Tooltip value={copy.tooltip()} placement="top" gutter={8}>
            <IconButton
              type="button"
              icon={copy.icon()}
              variant="ghost"
              data-copy-state={copy.state()}
              disabled={copy.disabled()}
              onClick={(event) => {
                event.stopPropagation()
                void copy.copy()
              }}
              data-slot="input-copy-button"
            />
          </Tooltip>
        </Show>
      </div>
      <Show when={local.description}>
        <Kobalte.Description data-slot="input-description">{local.description}</Kobalte.Description>
      </Show>
      <Kobalte.ErrorMessage data-slot="input-error">{local.error}</Kobalte.ErrorMessage>
    </Kobalte>
  )
}
