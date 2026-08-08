import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { createSignal } from "solid-js"
import { usePlatform } from "@/context/platform"
import { DialogSelectDirectory } from "./dialog-select-directory"
import {
  pickProjectDirectoriesWithRuntime,
  pickServerDirectoryWithDialog,
  type PickProjectDirectoriesOptions,
  type PickProjectDirectoriesResult,
} from "./project-directory-picker-model"

export function useProjectDirectoryPicker(): {
  pickProjectDirectories(options: PickProjectDirectoriesOptions): Promise<PickProjectDirectoriesResult | null>
} {
  const platform = usePlatform()
  const dialog = useDialog()
  const [pending, setPending] = createSignal(false)

  async function pickServer(options: PickProjectDirectoriesOptions): Promise<PickProjectDirectoriesResult | null> {
    return pickServerDirectoryWithDialog(dialog.push, options, (onSelect) => (
      // Push (not show) so the server browser stacks above an already-open
      // dialog (e.g. the project edit dialog) instead of closing it and
      // losing unsaved edits. With no active dialog, push behaves like show.
      <DialogSelectDirectory
        title={options.title}
        multiple={options.multiple}
        onSelect={(result) => {
          onSelect(result)
        }}
      />
    ))
  }

  async function pickProjectDirectories(
    options: PickProjectDirectoriesOptions,
  ): Promise<PickProjectDirectoriesResult | null> {
    return pickProjectDirectoriesWithRuntime(
      {
        platform,
        pickServer,
        showErrorToast: showToast,
        isPending: pending,
        setPending,
      },
      options,
    )
  }

  return { pickProjectDirectories }
}
