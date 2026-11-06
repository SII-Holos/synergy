import { createEffect } from "solid-js"
import { deriveShellSkin, useTheme } from "@ericsanchezok/synergy-ui/theme"
import { usePlatform } from "@/context/platform"

export function DesktopThemeSync() {
  const theme = useTheme()
  const platform = usePlatform()

  createEffect(() => {
    // A degraded registry gap renders default tokens under the retained
    // plugin theme id; persisting that mismatched pair would overwrite the
    // Desktop startup skin with plugin-id/default-variant state, so keep the
    // last persisted skin until the selection resolves again.
    if (theme.degraded()) return
    const source = theme.colorScheme()
    const shell = deriveShellSkin(theme.theme())
    void platform.desktopTheme
      ?.set({ source, themeId: theme.themeId(), light: shell.light, dark: shell.dark })
      .catch(() => undefined)
  })

  return null
}
