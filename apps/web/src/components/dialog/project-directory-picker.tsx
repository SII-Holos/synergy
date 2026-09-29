import type { Accessor } from "solid-js"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useLingui } from "@lingui/solid"
import { createSignal } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { DialogSelectDirectory } from "./dialog-select-directory"
import {
  pickProjectDirectoriesWithRuntime,
  pickServerDirectoryWithDialog,
  type PickProjectDirectoriesOptions,
  type PickProjectDirectoriesResult,
} from "./project-directory-picker-model"

export function useProjectDirectoryPicker(connection?: Accessor<string>): {
  pickProjectDirectories(options: PickProjectDirectoriesOptions): Promise<PickProjectDirectoriesResult | null>
} {
  const platform = usePlatform()
  const sdk = useGlobalSDK()
  const dialog = useDialog()
  const { _ } = useLingui()
  const [pending, setPending] = createSignal(false)

  async function pickServer(options: PickProjectDirectoriesOptions): Promise<PickProjectDirectoriesResult | null> {
    return pickServerDirectoryWithDialog(dialog.push, options, (onSelect) => (
      // Push (not show) so the server browser stacks above an already-open
      // dialog (e.g. the project edit dialog) instead of closing it and
      // losing unsaved edits. With no active dialog, push behaves like show.
      <DialogSelectDirectory
        client={connection ? createSynergyClient({ baseUrl: connection(), fetch: platform.fetch }) : undefined}
        serverUrl={connection?.()}
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
        serverUrl: connection?.() ?? sdk.url,
        pickServer,
        showErrorToast: showToast,
        translate: _,
        isPending: pending,
        setPending,
      },
      options,
    )
  }

  return { pickProjectDirectories }
}
