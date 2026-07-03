import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { createSignal } from "solid-js"
import { usePlatform } from "@/context/platform"
import { DialogSelectDirectory } from "./dialog-select-directory"
import {
  normalizeServerBrowserDirectoryResult,
  pickProjectDirectoriesWithRuntime,
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
    return await new Promise<PickProjectDirectoriesResult | null>((resolve) => {
      dialog.show(
        () => (
          <DialogSelectDirectory
            title={options.title}
            multiple={options.multiple}
            onSelect={(result) => {
              const directoryPaths = normalizeServerBrowserDirectoryResult(result)
              resolve(directoryPaths ? { directoryPaths, source: "server-browser" } : null)
            }}
          />
        ),
        () => resolve(null),
      )
    })
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
