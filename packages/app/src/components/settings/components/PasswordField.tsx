import { createSignal } from "solid-js"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"

export function PasswordField(props: { label: string; value: string; onChange: (value: string) => void }) {
  const [show, setShow] = createSignal(false)

  return (
    <div class="ds-password-field">
      <TextField
        label={props.label}
        type={show() ? "text" : "password"}
        value={props.value}
        onChange={(value) => props.onChange(value)}
      />
      <IconButton
        type="button"
        icon={show() ? "eye-off" : "eye"}
        variant="ghost"
        class="ds-password-toggle"
        onClick={() => setShow(!show())}
      />
    </div>
  )
}
