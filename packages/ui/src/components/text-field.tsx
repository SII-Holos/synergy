import { TextField as Kobalte } from "@kobalte/core/text-field"
import { createSignal, Show, splitProps } from "solid-js"
import type { ComponentProps } from "solid-js"
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
  const [copied, setCopied] = createSignal(false)

  async function handleCopy() {
    const value = local.value ?? local.defaultValue ?? ""
    let ok = false
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value)
      ok = true
    } else {
      try {
        const ta = document.createElement("textarea")
        ta.value = value
        ta.style.position = "fixed"
        ta.style.opacity = "0"
        ta.style.pointerEvents = "none"
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        ok = document.execCommand("copy")
        document.body.removeChild(ta)
      } catch {
        /* execCommand failed */
      }
    }
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  function handleClick() {
    if (local.copyable) handleCopy()
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
          <Tooltip value={copied() ? "Copied" : "Copy to clipboard"} placement="top" gutter={8}>
            <IconButton
              type="button"
              icon={copied() ? "check" : "copy"}
              variant="ghost"
              onClick={handleCopy}
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
