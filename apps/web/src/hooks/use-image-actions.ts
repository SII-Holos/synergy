import { useLingui } from "@lingui/solid"
import { usePlatform } from "@/context/platform"
import { createImageActions } from "@/utils/image-actions"

export function useImageActions(serverUrl: () => string) {
  const platform = usePlatform()
  const { _ } = useLingui()
  return createImageActions({
    serverUrl,
    fetcher: platform.fetch,
    fileAction: platform.browserNative?.fileAction,
    openLink: platform.openLink,
    translate: _,
  })
}
