import type { Platform } from "@/context/platform"

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
        const directoryPaths = normalizePickedDirectories(selected)
        if (!directoryPaths) return null
        return { directoryPaths, source: "native-local" }
      } catch {
        runtime.showErrorToast({
          type: "error",
          title: "Folder picker failed",
          description: "Could not open the folder picker. Please try again.",
        })
        return null
      }
    }

    return await runtime.pickServer(options)
  } finally {
    runtime.setPending(false)
  }
}
