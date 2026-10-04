import { createSignal } from "solid-js"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { useLingui } from "@lingui/solid"

export function PasswordField(props: {
  label: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
}) {
  const [show, setShow] = createSignal(false)
  const { _ } = useLingui()

  return (
    <div class="ds-password-field">
      <TextField
        label={props.label}
        hideLabel
        type={show() ? "text" : "password"}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(value) => props.onChange(value)}
      />
      <IconButton
        type="button"
        icon={show() ? "eye-off" : "eye"}
        variant="ghost"
        class="ds-password-toggle"
        aria-label={
          show()
            ? _({ id: "settings.password.hide.named", message: "Hide {field}", values: { field: props.label } })
            : _({ id: "settings.password.show.named", message: "Show {field}", values: { field: props.label } })
        }
        onClick={() => setShow(!show())}
      />
    </div>
  )
}
