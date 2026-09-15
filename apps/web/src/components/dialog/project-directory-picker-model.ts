import type { Platform } from "@/context/platform"
import { dialog, type AppMessageDescriptor } from "@/locales/messages"

export interface PickProjectDirectoriesOptions {
  title: string
  multiple: boolean
}

export interface PickProjectDirectoriesResult {
  directoryPaths: string[]
  source: "native-local" | "server-browser"
}

export type ProjectDirectoryPickerToast = (toast: { type: "error"; title: string; description: string }) => void

export interface ProjectDirectoryPickerRuntime {
  platform: Platform
  showErrorToast: ProjectDirectoryPickerToast
  translate(descriptor: AppMessageDescriptor): string
  pickServer(options: PickProjectDirectoriesOptions): Promise<PickProjectDirectoriesResult | null>
  isPending(): boolean
  setPending(pending: boolean): void
}

export function canUseNativeProjectDirectoryPicker(
  platform: Platform,
  status: Awaited<ReturnType<NonNullable<Platform["desktopServer"]>["status"]>> | undefined,
): boolean {
  return (
    platform.platform === "desktop" &&
    !!platform.openDirectoryPickerDialog &&
    status?.mode === "managed" &&
    status.state === "running"
  )
}

export function normalizePickedDirectories(selected: string | string[] | null): string[] | null {
  if (selected === null) return null
  const directoryPaths = Array.isArray(selected) ? selected : [selected]
  return directoryPaths.length > 0 ? directoryPaths : null
}

export function normalizeServerBrowserDirectoryResult(
  result: { directory: string | string[] } | null,
): string[] | null {
  if (!result) return null
  const directoryPaths = Array.isArray(result.directory) ? result.directory : [result.directory]
  return directoryPaths.length > 0 ? directoryPaths : null
}

export async function pickProjectDirectoriesWithRuntime(
  runtime: ProjectDirectoryPickerRuntime,
  options: PickProjectDirectoriesOptions,
): Promise<PickProjectDirectoriesResult | null> {
  if (runtime.isPending()) return null
  runtime.setPending(true)
  try {
    const status = await runtime.platform.desktopServer?.status().catch(() => null)
    if (canUseNativeProjectDirectoryPicker(runtime.platform, status)) {
      try {
        const selected = await runtime.platform.openDirectoryPickerDialog!({
          title: options.title,
          multiple: options.multiple,
        })
        if (selected !== null && !Array.isArray(selected) && typeof selected === "object") {
          runtime.showErrorToast({
            type: "error",
            title: runtime.translate(dialog.directoryPickerDenied),
            description: runtime.translate(dialog.directoryPickerDeniedHint),
          })
          return null
        }
        const directoryPaths = normalizePickedDirectories(selected)
        if (!directoryPaths) return null
        return { directoryPaths, source: "native-local" }
      } catch {
        runtime.showErrorToast({
          type: "error",
          title: runtime.translate(dialog.directoryPickerFailed),
          description: runtime.translate(dialog.directoryPickerCantOpen),
        })
        return null
      }
    }

    return await runtime.pickServer(options)
  } finally {
    runtime.setPending(false)
  }
}

export type ServerBrowserDialogOpen<T> = (element: () => T, onClose?: () => void) => void

/**
 * Open the server directory browser through a dialog host and resolve with
 * the picked directories. The host is expected to push (stack) the dialog
 * above any already-open dialog instead of replacing it, so an edit dialog
 * underneath keeps its unsaved state. Rendering stays with the caller so the
 * model stays free of JSX and the wiring is unit-testable.
 */
export function pickServerDirectoryWithDialog<T>(
  open: ServerBrowserDialogOpen<T>,
  options: PickProjectDirectoriesOptions,
  render: (onSelect: (result: { directory: string | string[] } | null) => void) => T,
): Promise<PickProjectDirectoriesResult | null> {
  return new Promise<PickProjectDirectoriesResult | null>((resolve) => {
    open(
      () =>
        render((result) => {
          const directoryPaths = normalizeServerBrowserDirectoryResult(result)
          resolve(directoryPaths ? { directoryPaths, source: "server-browser" } : null)
        }),
      () => resolve(null),
    )
  })
}
