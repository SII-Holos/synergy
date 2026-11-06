import { useLingui } from "@lingui/solid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { dialog } from "@/locales/messages"

export function FileCloseDialog(props: { name: string; choose: (choice: "save" | "discard" | "cancel") => void }) {
  const { _ } = useLingui()
  return (
    <Dialog
      title={_({ id: "files.close.title", message: "Save changes?" })}
      description={_({
        id: "files.close.description",
        message: "Save changes to {name} before leaving this file.",
        values: { name: props.name },
      })}
    >
      <div data-slot="dialog-actions" class="flex gap-2 justify-end p-4">
        <Button variant="ghost" onClick={() => props.choose("cancel")}>
          {_(dialog.cancel)}
        </Button>
        <Button variant="secondary" onClick={() => props.choose("discard")}>
          {_({ id: "files.close.discard", message: "Discard" })}
        </Button>
        <Button variant="primary" onClick={() => props.choose("save")}>
          {_({ id: "files.close.save", message: "Save" })}
        </Button>
      </div>
    </Dialog>
  )
}
