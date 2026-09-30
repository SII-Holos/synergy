import { createSignal, createUniqueId } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { locationCopy as copy } from "./task-location-copy"
import "./project-flow.css"

export function DialogIndependentCopy(props: {
  source: string
  deferred?: boolean
  onConfirm: (name?: string) => void
}) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const [name, setName] = createSignal("")
  const formID = createUniqueId()
  return (
    <Dialog
      title={_(copy.copy)}
      description={_(props.deferred ? copy.copyOnStart : copy.copyDescription)}
      footer={
        <div data-slot="dialog-actions">
          <Button type="button" variant="ghost" onClick={() => dialog.close()}>
            {_(copy.cancel)}
          </Button>
          <Button type="submit" form={formID}>
            {_(props.deferred ? copy.apply : copy.createCopy)}
          </Button>
        </div>
      }
      size="form"
    >
      <form
        id={formID}
        data-slot="dialog-form"
        class="project-flow"
        onSubmit={(event) => {
          event.preventDefault()
          dialog.close()
          props.onConfirm(name().trim() || undefined)
        }}
      >
        <p class="project-flow-path">{props.source}</p>
        <TextField
          autofocus
          label={_(copy.copyName)}
          value={name()}
          onChange={setName}
          placeholder={_(copy.copyNameHint)}
        />
      </form>
    </Dialog>
  )
}
